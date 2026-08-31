using System.Net;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// The credential path as it now really works: the bearer token a phone presents is hashed and
/// looked up in the <c>device</c> table, joined to the person and the tenant that can withdraw it
/// (profile-and-identity §7).
/// <para>
/// From the outside this increment changed nothing — the same token that worked before still
/// works — but underneath, <c>Auth:CompanyId</c> and <c>Auth:DeviceId</c> are gone and the
/// company an entry is stamped with now comes from a row rather than from configuration.
/// </para>
/// </summary>
public sealed class DeviceCredentialTests(TerenTestApp app) : ApiTestBase(app)
{
    private const string CompanyBToken = "teren-test-device-token-company-b";

    // ------------------------------------------------------------ it is a lookup, not a constant

    [Fact]
    public async Task The_seeded_device_token_authenticates()
    {
        var response = await Client.Get("/api/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_second_device_resolves_to_its_own_company()
    {
        // The property a static token could never have had, and the reason the product can now be
        // sold twice: two tokens, two companies, one API.
        await GivenCompanyBDeviceAsync();

        using var theirs = App.CreateClientWithToken(CompanyBToken);
        var response = await theirs.Get("/api/projects");

        var ids = (await response.JsonAsync()).EnumerateArray()
            .Select(p => p.GetGuid("id"))
            .ToList();

        ids.ShouldBe([TestIds.ProjectB1]);
        ids.ShouldNotContain(TestIds.ProjectA1);
    }

    [Fact]
    public async Task An_entry_is_stamped_with_the_device_rows_company_and_id()
    {
        // The same claim TenancyTests makes, restated here against a second tenant so it cannot
        // pass on a hardcoded company. Nothing about the caller's company is configured any more.
        await GivenCompanyBDeviceAsync();

        using var theirs = App.CreateClientWithToken(CompanyBToken);
        var entryId = Guid.NewGuid();

        var created = await theirs.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectB1));
        created.StatusCode.ShouldBe(HttpStatusCode.Accepted, await created.TextAsync());

        var entry = await LoadEntryAsync(entryId, TestIds.CompanyB);

        entry.ShouldNotBeNull();
        entry.CompanyId.ShouldBe(TestIds.CompanyB);
        entry.DeviceId.ShouldBe(TestIds.DeviceB);
    }

    [Fact]
    public async Task A_client_supplied_device_id_is_ignored_rather_than_honoured()
    {
        // D2. entry.device_id is PROVENANCE on an evidence row: the report can say which phone
        // recorded the day, so a phone that could name a different one would be telling a lie the
        // document then repeats. Until D1 this was an "optional override", which made sense while
        // one static token stood for a whole company and no device rows existed.
        //
        // ACCEPT-AND-IGNORE, not 400: a 400 would break any phone in the field still sending the
        // field, and the whole point of an outbox is that a captured day eventually gets through.
        // The shipped PWA does not send it, so today this closes a hazard nothing was using.
        await GivenCompanyBDeviceAsync();

        var entryId = Guid.NewGuid();
        var response = await Client.PostJson(
            "/api/entries",
            Wire.Entry(entryId, TestIds.ProjectA1, deviceId: TestIds.DeviceB));

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted, await response.TextAsync());

        var entry = await LoadEntryAsync(entryId);
        entry!.DeviceId.ShouldBe(TestIds.DeviceA);
        entry.DeviceId.ShouldNotBe(TestIds.DeviceB);
    }

    // ------------------------------------------------------------ revocation

    [Fact]
    public async Task A_revoked_device_is_refused_on_its_very_next_request()
    {
        // THE MUTATION TARGET, and it is written to catch one specific mutation: a token-to-
        // principal cache. Adding even a 60-second one would make revocation "mostly" work, which
        // for a security control means not work.
        //
        // Two properties of this test are load-bearing and must survive any edit:
        //
        //   * The revocation happens through a DIFFERENT SCOPE than the one that authenticated —
        //     a separate DbContext on the identity model, standing in for the admin surface that
        //     arrives at D3 and for a founder with psql. A cache local to the request scope would
        //     otherwise be invisible.
        //   * THERE IS NO await Task.Delay ANYWHERE IN THIS TEST. The absence of the sleep IS the
        //     assertion. A version written with a two-second wait would pass against a
        //     sixty-second cache and prove nothing at all.
        var entryId = await GivenEntryAsync();
        entryId.ShouldNotBe(Guid.Empty);

        await RevokeDeviceAsync(TestIds.DeviceA);

        var afterRevocation = await Client.Get("/api/entries");

        afterRevocation.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_revoked_device_cannot_write_either()
    {
        await RevokeDeviceAsync(TestIds.DeviceA);

        var entryId = Guid.NewGuid();
        var response = await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA1));

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await CountEntriesAsync(entryId)).ShouldBe(0);
    }

    [Fact]
    public async Task Revoking_one_companys_device_leaves_another_companys_alone()
    {
        await GivenCompanyBDeviceAsync();
        await RevokeDeviceAsync(TestIds.DeviceA);

        using var theirs = App.CreateClientWithToken(CompanyBToken);

        (await theirs.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Revocation_is_a_stamp_and_the_evidence_it_recorded_survives()
    {
        // "Revocation is a soft stamp, never a DELETE": entry.device_id is provenance on an
        // evidence row, and an administrative action must not degrade evidence.
        //
        // Worth knowing while reading this: there is currently NO foreign key from
        // entry.device_id to device, so the database does not yet refuse a hard delete on its own
        // (§7 says otherwise and is wrong on that point). Until one exists, this discipline is
        // enforced by code and by this test — which makes the test matter more, not less.
        var entryId = await GivenEntryAsync();

        await RevokeDeviceAsync(TestIds.DeviceA);

        await using var identity = App.CreateIdentityDbContext();
        var device = await identity.Devices.SingleAsync(d => d.Id == TestIds.DeviceA, Ct);
        device.RevokedAt.ShouldNotBeNull();

        var entry = await LoadEntryAsync(entryId);
        entry.ShouldNotBeNull();
        entry.DeviceId.ShouldBe(TestIds.DeviceA);
    }

    // ------------------------------------------------------------ the other two withdrawals

    [Fact]
    public async Task A_disabled_worker_cannot_record()
    {
        // "Remove a worker" is disabled_at, and it must reach his phone.
        await using (var identity = App.CreateIdentityDbContext())
        {
            var worker = await identity.Users.SingleAsync(u => u.Id == TestIds.WorkerA, Ct);
            worker.DisabledAt = DateTime.UtcNow;
            await identity.SaveChangesAsync(Ct);
        }

        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_suspended_company_stops_every_one_of_its_phones()
    {
        await using (var db = App.CreateDbContext(companyId: null))
        {
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE company SET suspended_at = now() WHERE id = {TestIds.CompanyA}", Ct);
        }

        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_unknown_token_is_refused()
    {
        using var stranger = App.CreateClientWithToken("trn_d_this-token-was-never-issued-at-all");

        (await stranger.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    // ------------------------------------------------------------ no oracle

    [Fact]
    public async Task Every_rejection_is_byte_identical()
    {
        // "Revoked" versus "unknown" is an oracle: it tells a caller that a token he holds was
        // once real, and which of several things is wrong. This codebase already goes to the
        // trouble of making a foreign media id 404 rather than 409; the credential path gets the
        // same treatment. All four failures must be indistinguishable in status, headers and body.
        var unknown = await ReadRejectionAsync(
            () => Task.FromResult(App.CreateClientWithToken("trn_d_never-issued-token-value")));

        var revoked = await ReadRejectionAsync(async () =>
        {
            await RevokeDeviceAsync(TestIds.DeviceA);
            return App.CreateClient();
        });

        await App.ResetAsync();

        var disabled = await ReadRejectionAsync(async () =>
        {
            await using var identity = App.CreateIdentityDbContext();
            var worker = await identity.Users.SingleAsync(u => u.Id == TestIds.WorkerA, Ct);
            worker.DisabledAt = DateTime.UtcNow;
            await identity.SaveChangesAsync(Ct);
            return App.CreateClient();
        });

        await App.ResetAsync();

        var suspended = await ReadRejectionAsync(async () =>
        {
            await using var db = App.CreateDbContext(companyId: null);
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE company SET suspended_at = now() WHERE id = {TestIds.CompanyA}", Ct);
            return App.CreateClient();
        });

        revoked.ShouldBe(unknown);
        disabled.ShouldBe(unknown);
        suspended.ShouldBe(unknown);
    }

    [Fact]
    public async Task The_presented_token_is_never_echoed_back()
    {
        using var client = App.CreateClientWithToken("trn_d_secret-value-that-must-not-appear");

        var response = await client.Get("/api/projects");

        (await response.TextAsync()).ShouldNotContain("secret-value-that-must-not-appear");
    }

    // ------------------------------------------------------------ arrange helpers

    /// <summary>
    /// Revokes a device the way an administrator will at D3 — through a <b>different scope</b>
    /// than the one that authenticated the caller. That separation is the point: a cache living
    /// inside the request scope would be invisible to a test that revoked through the same one.
    /// </summary>
    private async Task RevokeDeviceAsync(Guid deviceId)
    {
        await using var identity = App.CreateIdentityDbContext();

        var device = await identity.Devices.SingleAsync(d => d.Id == deviceId, Ct);
        device.RevokedAt = DateTime.UtcNow;
        await identity.SaveChangesAsync(Ct);
    }

    private async Task GivenCompanyBDeviceAsync()
    {
        await using var identity = App.CreateIdentityDbContext();
        var now = DateTime.UtcNow;

        identity.Users.Add(new AppUser
        {
            Id = TestIds.WorkerB,
            CompanyId = TestIds.CompanyB,
            Role = AppUserRole.Worker,
            Username = "nenad.ilic",
            DisplayName = "Nenad Ilić",
            Language = "sr",
            CreatedAt = now,
        });

        identity.Devices.Add(new Device
        {
            Id = TestIds.DeviceB,
            CompanyId = TestIds.CompanyB,
            UserId = TestIds.WorkerB,
            Name = "Nenadov telefon",
            TokenHash = CredentialTokens.Hash(CompanyBToken),
            CreatedAt = now,
        });

        await identity.SaveChangesAsync(Ct);
    }

    private static async Task<string> ReadRejectionAsync(Func<Task<HttpClient>> arrange)
    {
        using var client = await arrange();

        var response = await client.Get("/api/projects");

        return await RejectionFingerprint.OfAsync(response);
    }
}
