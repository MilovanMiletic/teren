using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// <c>POST /auth/activate</c>: a foreman binds a phone with his username and a one-time code, once
/// — and afterwards the app opens straight to the record button with no sign-in and no network
/// call (§2 decision 5).
/// <para>
/// <b>Activation takes a username AND a code, and that is not ceremony.</b> It means a code seen
/// over a shoulder, forwarded by accident, or left in a group chat is useless on its own. The code
/// alone never authenticates anything.
/// </para>
/// <para>
/// <b>The code is single-use, and this is the point on which the design refuses to bend.</b> A
/// reusable code tied to a username is a permanent password shared over WhatsApp that never
/// expires, and anyone who ever saw that message could record entries under that man's name — with
/// the report saying it was him.
/// </para>
/// </summary>
public sealed class ActivationTests(TerenTestApp app) : ApiTestBase(app)
{
    // ------------------------------------------------------------ the happy path

    [Fact]
    public async Task A_worker_activates_a_phone_and_it_records_immediately()
    {
        var code = await GivenLiveCodeAsync();

        var response = await Activate(DemoSeeder.WorkerUsername, code);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var body = await response.JsonAsync();
        body.GetText("device_token").ShouldStartWith(CredentialTokens.DevicePrefix);
        body.GetText("username").ShouldBe(DemoSeeder.WorkerUsername);
        body.GetGuid("user_id").ShouldBe(TestIds.WorkerA);
        body.GetProperty("company").GetGuid("id").ShouldBe(TestIds.CompanyA);

        // The end that matters: the new phone can capture a day's work, and the entry is stamped
        // with the device the token resolved to — never with anything a body claimed.
        using var phone = App.CreateClientWithToken(body.GetText("device_token"));
        var entryId = Guid.NewGuid();

        var created = await phone.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA1));
        created.StatusCode.ShouldBe(HttpStatusCode.Accepted, await created.TextAsync());

        (await LoadEntryAsync(entryId))!.DeviceId.ShouldBe(body.GetGuid("device_id"));
    }

    [Fact]
    public async Task The_device_token_is_stored_only_as_a_hash()
    {
        var code = await GivenLiveCodeAsync();

        var token = (await (await Activate(DemoSeeder.WorkerUsername, code)).JsonAsync())
            .GetText("device_token");

        var device = (await NewlyActivatedDevicesAsync()).Single();

        device.TokenHash.ShouldBe(CredentialTokens.Hash(token));
        device.TokenHash.ShouldNotContain(token);
    }

    [Theory]
    // The dashed display form, exactly as it is pasted out of a chat message.
    [InlineData(true, false, false)]
    // Lower case, as a phone keyboard offers it.
    [InlineData(false, true, false)]
    // Cyrillic homoglyphs, as a man on a Cyrillic keyboard types them. THIS is the case that used
    // to fail silently: Fold dropped every non-ASCII character, the code came out short, and he
    // was told his code was wrong.
    [InlineData(false, false, true)]
    public async Task A_code_is_folded_before_it_is_judged(
        bool dashed, bool lowercase, bool cyrillic)
    {
        // For the Cyrillic case the code has to actually contain a letter the table maps, or the
        // test proves nothing about the table at all — a draw of "12345678" would pass on the old
        // broken Fold. Re-issuing until it does is cheap and keeps the assertion honest.
        var canonical = await GivenLiveCodeAsync(
            until: code => !cyrillic || code.Any(Homoglyphable.Contains));

        var typed = dashed ? ActivationCodeFormat.Format(canonical) : canonical;
        typed = lowercase ? typed.ToLowerInvariant() : typed;
        typed = cyrillic ? ToCyrillicHomoglyphs(typed) : typed;

        if (cyrillic)
        {
            typed.ShouldNotBe(canonical, "the code carried no Cyrillic, so nothing was proven");
        }

        var response = await Activate(DemoSeeder.WorkerUsername, typed);

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
    }

    // ------------------------------------------------------------ single use

    [Fact]
    public async Task A_consumed_code_cannot_be_used_again()
    {
        // THE MUTATION TARGET. Drop `consumed_at IS NULL` from the claim's WHERE clause and this
        // turns red — and with it goes the whole difference between an activation code and a
        // permanent password shared over WhatsApp.
        var code = await GivenLiveCodeAsync();

        (await Activate(DemoSeeder.WorkerUsername, code)).StatusCode
            .ShouldBe(HttpStatusCode.OK);

        var second = await Activate(DemoSeeder.WorkerUsername, code);

        second.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // And nothing was written on the way to that refusal: no orphan device row from the
        // rolled-back transaction.
        (await NewlyActivatedDevicesAsync()).Count.ShouldBe(1);
    }

    [Fact]
    public async Task A_consumed_code_stops_holding_its_plaintext()
    {
        // ck_activation_code_display_cleared says a dead code cannot still be holding plaintext.
        // The constraint would raise on a write that forgot; this proves the write remembers.
        var code = await GivenLiveCodeAsync();

        await Activate(DemoSeeder.WorkerUsername, code);

        var row = (await LoadActivationCodesAsync(TestIds.WorkerA)).Single();
        row.ConsumedAt.ShouldNotBeNull();
        row.CodeDisplay.ShouldBeNull();
        row.ConsumedDeviceId.ShouldBe((await NewlyActivatedDevicesAsync()).Single().Id);
    }

    [Fact]
    public async Task An_expired_code_is_refused()
    {
        var code = await GivenLiveCodeAsync();

        await using (var identity = App.CreateIdentityDbContext())
        {
            // Moved back in time rather than waited out: the shipped TTL is seven days.
            await identity.ActivationCodes
                .Where(c => c.UserId == TestIds.WorkerA)
                .ExecuteUpdateAsync(
                    u => u.SetProperty(c => c.ExpiresAt, DateTime.UtcNow.AddSeconds(-1)), Ct);
        }

        var response = await Activate(DemoSeeder.WorkerUsername, code);

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await NewlyActivatedDevicesAsync()).ShouldBeEmpty();
    }

    [Fact]
    public async Task A_superseded_code_is_refused_and_the_new_one_works()
    {
        var first = await GivenLiveCodeAsync();
        var second = await GivenLiveCodeAsync();

        first.ShouldNotBe(second);

        (await Activate(DemoSeeder.WorkerUsername, first)).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
        (await Activate(DemoSeeder.WorkerUsername, second)).StatusCode
            .ShouldBe(HttpStatusCode.OK);
    }

    // ------------------------------------------------------------ replacing a phone

    [Fact]
    public async Task Activating_a_new_phone_revokes_the_old_one_in_the_same_breath()
    {
        // §14 question 2. Once a worker can re-activate himself by email, NOT revoking would mean
        // a lost or stolen phone keeps recording under his name indefinitely.
        var firstCode = await GivenLiveCodeAsync();
        var first = (await (await Activate(DemoSeeder.WorkerUsername, firstCode)).JsonAsync())
            .GetText("device_token");

        using var oldPhone = App.CreateClientWithToken(first);
        (await oldPhone.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var secondCode = await GivenLiveCodeAsync();
        var second = (await (await Activate(DemoSeeder.WorkerUsername, secondCode)).JsonAsync())
            .GetText("device_token");

        using var newPhone = App.CreateClientWithToken(second);

        // No sleep, no sweep, no push: the check runs on every request.
        (await oldPhone.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await newPhone.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_superseded_phone_is_stamped_and_its_evidence_survives()
    {
        var firstCode = await GivenLiveCodeAsync();
        var first = (await (await Activate(DemoSeeder.WorkerUsername, firstCode)).JsonAsync())
            .GetText("device_token");

        using var oldPhone = App.CreateClientWithToken(first);
        var entryId = Guid.NewGuid();
        (await oldPhone.PostJson("/api/entries", Wire.Entry(entryId, TestIds.ProjectA1)))
            .StatusCode.ShouldBe(HttpStatusCode.Accepted);

        var secondCode = await GivenLiveCodeAsync();
        await Activate(DemoSeeder.WorkerUsername, secondCode);

        // A stamp, never a delete: entry.device_id is provenance on an evidence row and an
        // administrative action must not degrade evidence.
        var devices = await NewlyActivatedDevicesAsync();
        devices.Count.ShouldBe(2);
        devices[0].RevokedAt.ShouldNotBeNull();
        devices[0].RevokedByUserId.ShouldBe(TestIds.WorkerA);
        devices[1].RevokedAt.ShouldBeNull();

        (await LoadEntryAsync(entryId))!.DeviceId.ShouldBe(devices[0].Id);

        (await LoadAuditAsync()).Select(a => a.Action)
            .ShouldContain(AdminAuditActions.DeviceSuperseded);
    }

    // ------------------------------------------------------------ no oracle

    [Fact]
    public async Task Every_activation_failure_is_byte_identical()
    {
        // Wrong code, unknown username, disabled worker: which one it was is precisely what an
        // attacker wants to learn, and the man on site cannot act on the distinction anyway.
        await GivenLiveCodeAsync();

        var wrongCode = await RejectionFingerprint.OfAsync(
            await Activate(DemoSeeder.WorkerUsername, "ZZZZ-ZZZZ"));

        var unknownUser = await RejectionFingerprint.OfAsync(
            await Activate("nobody.at.all", "ZZZZ-ZZZZ"));

        var malformed = await RejectionFingerprint.OfAsync(
            await Activate(DemoSeeder.WorkerUsername, "not-a-code"));

        unknownUser.ShouldBe(wrongCode);
        malformed.ShouldBe(wrongCode);
    }

    [Fact]
    public async Task A_disabled_worker_cannot_activate_a_phone()
    {
        var code = await GivenLiveCodeAsync();

        await using (var identity = App.CreateIdentityDbContext())
        {
            var worker = await identity.Users.SingleAsync(u => u.Id == TestIds.WorkerA, Ct);
            worker.DisabledAt = DateTime.UtcNow;
            await identity.SaveChangesAsync(Ct);
        }

        (await Activate(DemoSeeder.WorkerUsername, code)).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
        (await NewlyActivatedDevicesAsync()).ShouldBeEmpty();
    }

    [Fact]
    public async Task A_code_alone_does_not_activate_anything()
    {
        // The whole reason activation takes two things: a code left in a group chat is useless
        // without the name it was issued to.
        await GivenCompanyAdminAsync();
        var code = await GivenLiveCodeAsync();

        var otherWorker = await CreateWorkerAsync("Nenad Ilić");

        (await Activate(otherWorker, code)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    // ------------------------------------------------------------ self-service (§2 decision 14)

    [Fact]
    public async Task Asking_for_a_code_answers_the_same_way_whether_or_not_the_username_exists()
    {
        var known = await RequestCode(DemoSeeder.WorkerUsername);
        var unknown = await RequestCode("no.such.person");

        known.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        unknown.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        (await known.TextAsync()).ShouldBe(await unknown.TextAsync());
    }

    [Fact]
    public async Task Asking_for_a_code_issues_one_when_the_worker_has_an_address()
    {
        await using (var identity = App.CreateIdentityDbContext())
        {
            var worker = await identity.Users.SingleAsync(u => u.Id == TestIds.WorkerA, Ct);
            worker.Email = "zoran@vodoinstal-petrovic.test";
            await identity.SaveChangesAsync(Ct);
        }

        await RequestCode(DemoSeeder.WorkerUsername);

        var codes = await LoadActivationCodesAsync(TestIds.WorkerA);
        codes.Count.ShouldBe(1);
        codes[0].CodeDisplay.ShouldNotBeNull();
        codes[0].CreatedByUserId.ShouldBe(TestIds.WorkerA);

        (await LoadAuditAsync()).Select(a => a.Action)
            .ShouldContain(AdminAuditActions.ActivationCodeSelfRequested);
    }

    [Fact]
    public async Task Asking_for_a_code_issues_nothing_when_the_worker_has_no_address()
    {
        // Deliberate: a code nobody can be sent is not worth destroying a usable one for. The
        // fixture's worker has no email, so the boss's live code survives a stranger typing his
        // username into the activation screen.
        var live = await GivenLiveCodeAsync();

        await RequestCode(DemoSeeder.WorkerUsername);

        (await LoadActivationCodesAsync(TestIds.WorkerA)).Count.ShouldBe(1);
        (await Activate(DemoSeeder.WorkerUsername, live)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    // ------------------------------------------------------------ helpers

    private Task<HttpResponseMessage> Activate(string username, string code) =>
        ActivateOn(App.CreateAnonymousClient(), username, code);

    private static async Task<HttpResponseMessage> ActivateOn(
        HttpClient client, string username, string code)
    {
        using (client)
        {
            return await client.PostJson(
                "/auth/activate",
                new JsonObject
                {
                    ["username"] = username,
                    ["activation_code"] = code,
                    ["device_name"] = "Zoranov telefon",
                });
        }
    }

    private async Task<HttpResponseMessage> RequestCode(string username)
    {
        using var anonymous = App.CreateAnonymousClient();

        return await anonymous.PostJson(
            "/auth/activation-code", new JsonObject { ["username"] = username });
    }

    /// <summary>
    /// A live code for the fixture's worker, issued through the real admin route — so an
    /// activation test can never pass against a code shape the admin surface would not produce.
    /// Returns the canonical (undashed) form.
    /// </summary>
    private async Task<string> GivenLiveCodeAsync(Func<string, bool>? until = null)
    {
        using var owner = await GivenOwnerAsync();

        for (var attempt = 0; attempt < 40; attempt++)
        {
            var response = await owner.PostNothing(
                $"/api/workers/{TestIds.WorkerA}/activation-code");
            response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

            var code = ActivationCodeFormat.Fold((await response.JsonAsync()).GetText("code"));

            if (until is null || until(code))
            {
                return code;
            }
        }

        throw new ShouldAssertException(
            "Could not draw an activation code matching the test's requirement in 40 attempts.");
    }

    /// <summary>The Latin letters the Cyrillic homoglyph table can produce a twin for, and which
    /// the Crockford alphabet can actually contain.</summary>
    private const string Homoglyphable = "AEKMPCTYX";

    private async Task<HttpClient> GivenOwnerAsync()
    {
        if (await LoadUserAsync(TestIds.CompanyAdminA) is null)
        {
            await GivenCompanyAdminAsync();
        }

        return await SignInAsync(TestIds.CompanyAdminAEmail);
    }

    private async Task<string> CreateWorkerAsync(string displayName)
    {
        using var owner = await GivenOwnerAsync();

        var response = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = displayName });
        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());

        return (await response.JsonAsync()).GetProperty("worker").GetText("username");
    }

    /// <summary>
    /// Rewrites a code into the Cyrillic letters that are drawn identically, so the test types
    /// what a man on a Cyrillic keyboard types. Only the ten pairs the contract lists.
    /// </summary>
    private static string ToCyrillicHomoglyphs(string code) => string.Concat(code.Select(c =>
        char.ToUpperInvariant(c) switch
        {
            'A' => 'А',
            'E' => 'Е',
            'K' => 'К',
            'M' => 'М',
            'P' => 'Р',
            'C' => 'С',
            'T' => 'Т',
            'Y' => 'У',
            'X' => 'Х',
            _ => c,
        }));
}
