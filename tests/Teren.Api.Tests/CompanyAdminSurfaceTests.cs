using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// The customer's own surface: his foremen, their codes, the message he pastes into one man's
/// chat, and the button that takes a phone away.
/// <para>
/// <b>The property this file exists to prove is cross-tenant scoping, and it is not free here.</b>
/// Everywhere else in the API, tenant scoping is automatic — the evidence model's global query
/// filters are deny-by-default and no handler writes a company clause. The identity model
/// deliberately has none (the credential authenticator must read it before a tenant is known), so
/// on this surface a forgotten <c>WHERE company_id</c> is a cross-tenant read. Every route below
/// is therefore proven against a <em>real</em> row belonging to company B.
/// </para>
/// </summary>
public sealed class CompanyAdminSurfaceTests(TerenTestApp app) : ApiTestBase(app)
{
    // ------------------------------------------------------------ workers

    [Fact]
    public async Task The_worker_list_shows_this_companys_foremen_and_nobody_elses()
    {
        await GivenCompanyBWorkerAsync();
        using var owner = await GivenCompanyAdminClientAsync();

        var body = await (await owner.Get("/api/workers")).JsonAsync();

        var ids = body.GetProperty("workers").EnumerateArray()
            .Select(w => w.GetGuid("id"))
            .ToList();

        ids.ShouldBe([TestIds.WorkerA]);
        ids.ShouldNotContain(TestIds.WorkerB);

        // Admins are not "workers": the surface manages the men who record. His own row is /api/me.
        ids.ShouldNotContain(TestIds.CompanyAdminA);
    }

    [Fact]
    public async Task Creating_a_worker_proposes_a_username_and_issues_his_first_code()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.PostJson(
            "/api/workers",
            new JsonObject
            {
                ["display_name"] = "Miloš Đorđević",
                ["email"] = "  MILOS@Primer.TEST ",
            });

        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());

        var body = await response.JsonAsync();
        var worker = body.GetProperty("worker");

        // Cyrillic transliterated, diacritics folded, lower case: this string is read aloud over a
        // phone and typed on a keyboard whose layout may be Cyrillic.
        worker.GetText("username").ShouldBe("milos.djordjevic");
        worker.GetText("display_name").ShouldBe("Miloš Đorđević");
        worker.GetText("email").ShouldBe("milos@primer.test");
        worker.GetProperty("active_device_count").GetInt32().ShouldBe(0);
        worker.GetProperty("has_live_activation_code").GetBoolean().ShouldBeTrue();

        // Creating a worker you cannot then activate is not a finished action.
        var code = body.GetProperty("activation_code");
        code.GetText("code").Length.ShouldBe(ActivationCodeFormat.Length + 1);   // XKD4-7HMP
        code.GetText("email_delivery").ShouldBe("not_configured");
    }

    [Fact]
    public async Task A_second_man_with_the_same_name_gets_the_next_free_username()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var first = await CreateWorkerAsync(owner, "Zoran Jovanović");
        var second = await CreateWorkerAsync(owner, "Zoran Jovanović");

        // The fixture's seeded foreman already holds zoran.jovanovic.
        first.ShouldBe("zoran.jovanovic2");
        second.ShouldBe("zoran.jovanovic3");
    }

    [Fact]
    public async Task A_worker_created_without_an_address_is_told_so_rather_than_refused()
    {
        // Decision 6: a worker's email is optional. Onboarding must never block on a missing
        // address — the admin reads the code off his screen instead.
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = "Ivan Perić" });

        response.StatusCode.ShouldBe(HttpStatusCode.Created);

        var body = await response.JsonAsync();
        body.GetProperty("worker").IsNull("email").ShouldBeTrue();
        body.GetProperty("activation_code").GetText("email_delivery").ShouldBe("no_address");
        body.GetProperty("activation_code").GetText("code").ShouldNotBeEmpty();
    }

    [Fact]
    public async Task A_worker_created_here_can_actually_activate_a_phone()
    {
        // End to end through the two halves that have to agree on the code's canonical form: the
        // admin route formats it for a human, and activation folds what a human types back.
        using var owner = await GivenCompanyAdminClientAsync();

        var created = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = "Saša Nikolić" });
        var body = await created.JsonAsync();

        using var phone = App.CreateAnonymousClient();
        var response = await phone.PostJson(
            "/auth/activate",
            new JsonObject
            {
                ["username"] = body.GetProperty("worker").GetText("username"),
                ["activation_code"] = body.GetProperty("activation_code").GetText("code"),
            });

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        // No device_name supplied: it falls back to his own name rather than refusing to activate
        // a phone over a missing label.
        (await response.JsonAsync()).GetText("device_name").ShouldBe("Saša Nikolić");
    }

    [Fact]
    public async Task An_explicitly_taken_username_is_a_409_the_client_can_branch_on()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.PostJson(
            "/api/workers",
            new JsonObject
            {
                ["display_name"] = "Neko Drugi",
                ["username"] = DemoSeeder.WorkerUsername,
            });

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.JsonAsync()).GetText("code").ShouldBe("username_taken");
    }

    [Fact]
    public async Task Disabling_a_worker_stops_his_phone_and_never_deletes_him()
    {
        // "Remove a worker" is a stamp: every foreign key into app_user is RESTRICT, because a man
        // who authored evidence has to stay nameable.
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.PatchJson(
            $"/api/workers/{TestIds.WorkerA}", new JsonObject { ["disabled"] = true });

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        (await response.JsonAsync()).IsNull("disabled_at").ShouldBeFalse();

        (await LoadUserAsync(TestIds.WorkerA)).ShouldNotBeNull();

        // It reaches his phone on the next request, with nothing to push and nothing to expire.
        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        (await LoadAuditAsync()).Select(a => a.Action)
            .ShouldContain(AdminAuditActions.WorkerDisabled);
    }

    [Fact]
    public async Task Patching_another_companys_worker_is_404_and_changes_nothing()
    {
        await GivenCompanyBWorkerAsync();
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.PatchJson(
            $"/api/workers/{TestIds.WorkerB}", new JsonObject { ["display_name"] = "Preuzeto" });

        // 404, not 403: the answer depended on which row was named, and "exists but not yours" is
        // exactly the signal an enumerator wants.
        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        response.StatusCode.ShouldNotBe(HttpStatusCode.Forbidden);

        (await LoadUserAsync(TestIds.WorkerB))!.DisplayName.ShouldBe("Nenad Ilić");
    }

    [Fact]
    public async Task Another_companys_worker_answers_exactly_as_one_that_does_not_exist()
    {
        await GivenCompanyBWorkerAsync();
        using var owner = await GivenCompanyAdminClientAsync();

        var foreign = await owner.Get($"/api/workers/{TestIds.WorkerB}/activation-code");
        var missing = await owner.Get($"/api/workers/{Guid.NewGuid()}/activation-code");

        foreign.StatusCode.ShouldBe(missing.StatusCode);
        foreign.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    // ------------------------------------------------------------ codes

    [Fact]
    public async Task Reading_the_live_code_does_not_kill_it()
    {
        // The operational trap §5 reversed the "hash only" design to avoid: the admin sends a code
        // by Viber, taps later to look at it, and re-issue kills the code the worker is about to
        // type.
        using var owner = await GivenCompanyAdminClientAsync();

        var issued = await (await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code")).JsonAsync();

        var read = await (await owner.Get(
            $"/api/workers/{TestIds.WorkerA}/activation-code")).JsonAsync();

        read.GetText("code").ShouldBe(issued.GetText("code"));
        (await LoadActivationCodesAsync(TestIds.WorkerA)).Count.ShouldBe(1);
    }

    [Fact]
    public async Task A_worker_with_no_code_yet_is_a_409_with_a_branchable_code()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.Get($"/api/workers/{TestIds.WorkerA}/activation-code");

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.JsonAsync()).GetText("code").ShouldBe("no_live_activation_code");
    }

    [Fact]
    public async Task Re_issuing_supersedes_the_previous_code_and_clears_its_plaintext()
    {
        // ux_activation_code_live guarantees at most one typeable code per worker. Inserting a
        // second without retiring the first is a constraint violation — that is the design working
        // — and ck_activation_code_display_cleared refuses to let the dead one keep its plaintext.
        using var owner = await GivenCompanyAdminClientAsync();

        await owner.PostNothing($"/api/workers/{TestIds.WorkerA}/activation-code");
        await owner.PostNothing($"/api/workers/{TestIds.WorkerA}/activation-code");

        var codes = await LoadActivationCodesAsync(TestIds.WorkerA);

        codes.Count.ShouldBe(2);
        codes[0].SupersededAt.ShouldNotBeNull();
        codes[0].CodeDisplay.ShouldBeNull();
        codes[1].SupersededAt.ShouldBeNull();
        codes[1].CodeDisplay.ShouldNotBeNull();
    }

    [Fact]
    public async Task A_code_is_stored_as_a_hash_of_its_canonical_form()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var display = (await (await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code")).JsonAsync()).GetText("code");

        var row = (await LoadActivationCodesAsync(TestIds.WorkerA)).Single();

        row.CodeHash.ShouldBe(CredentialTokens.Hash(ActivationCodeFormat.Fold(display)));
        row.CodeHash.ShouldNotContain(display);
    }

    // ------------------------------------------------------------ share text

    [Fact]
    public async Task The_share_text_carries_the_two_things_a_man_has_to_type()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var code = (await (await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code")).JsonAsync()).GetText("code");

        var response = await owner.Get($"/api/workers/{TestIds.WorkerA}/share-text");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var body = await response.JsonAsync();
        var text = body.GetText("text");

        // His language, not the project's: a report speaks the project's language because the
        // client reads it; an invite speaks the recipient's, because he does.
        body.GetText("language").ShouldBe("sr");
        text.ShouldContain(DemoSeeder.WorkerUsername);
        text.ShouldContain(code);
        text.ShouldContain("Zoran");
        // Single use and an expiry, said out loud, or somebody keeps the message and tries it
        // next month.
        text.ShouldContain("samo jednom");
    }

    [Fact]
    public async Task Share_text_refuses_rather_than_quietly_issuing_a_new_code()
    {
        // A GET that supersedes the code the worker is holding would be the worst kind of
        // convenience.
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.Get($"/api/workers/{TestIds.WorkerA}/share-text");

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await LoadActivationCodesAsync(TestIds.WorkerA)).ShouldBeEmpty();
    }

    [Fact]
    public async Task There_is_no_bulk_code_export()
    {
        // Decision 13, asserted as an absence: a group chat carrying six codes lets any worker
        // activate a phone under another man's name, and every entry he records is then signed
        // with that name. The worker LIST must never carry codes.
        using var owner = await GivenCompanyAdminClientAsync();
        await owner.PostNothing($"/api/workers/{TestIds.WorkerA}/activation-code");

        var live = (await LoadActivationCodesAsync(TestIds.WorkerA)).Single().CodeDisplay!;

        foreach (var route in new[] { "/api/workers", "/api/devices" })
        {
            (await (await owner.Get(route)).TextAsync()).ShouldNotContain(live);
        }
    }

    // ------------------------------------------------------------ devices

    [Fact]
    public async Task The_device_list_shows_this_companys_phones_and_nobody_elses()
    {
        await GivenCompanyBWorkerAsync(withDevice: true);
        using var owner = await GivenCompanyAdminClientAsync();

        var body = await (await owner.Get("/api/devices")).JsonAsync();
        var devices = body.GetProperty("devices").EnumerateArray().ToList();

        devices.Select(d => d.GetGuid("id")).ShouldBe([TestIds.DeviceA]);
        devices[0].GetText("worker_display_name").ShouldBe("Zoran Jovanović");
        devices[0].GetText("worker_username").ShouldBe(DemoSeeder.WorkerUsername);
    }

    [Fact]
    public async Task Last_seen_is_stamped_by_a_phone_simply_using_the_api()
    {
        // Without it the device list says "last seen: never" for every phone in the company, which
        // makes it useless for the one question it is read to answer: which of these am I taking
        // away.
        using var owner = await GivenCompanyAdminClientAsync();
        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var devices = await (await owner.Get("/api/devices")).JsonAsync();

        devices.GetProperty("devices").EnumerateArray().Single()
            .IsNull("last_seen_at").ShouldBeFalse();
    }

    [Fact]
    public async Task Revoking_a_phone_stops_it_on_its_very_next_request()
    {
        // The admin half of the mutation DeviceCredentialTests proves from psql: revocation
        // reaches a phone through a DIFFERENT scope than the one that authenticated it, with NO
        // await Task.Delay anywhere — the absence of the sleep is the assertion.
        using var owner = await GivenCompanyAdminClientAsync();
        (await Client.Get("/api/entries")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var response = await owner.Delete($"/api/devices/{TestIds.DeviceA}");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        (await Client.Get("/api/entries")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Revoking_is_a_stamp_and_the_evidence_it_recorded_survives()
    {
        var entryId = await GivenEntryAsync();
        using var owner = await GivenCompanyAdminClientAsync();

        await owner.Delete($"/api/devices/{TestIds.DeviceA}");

        var device = (await LoadDevicesAsync(TestIds.WorkerA)).ShouldHaveSingleItem();
        device.RevokedAt.ShouldNotBeNull();
        device.RevokedByUserId.ShouldBe(TestIds.CompanyAdminA);

        (await LoadEntryAsync(entryId))!.DeviceId.ShouldBe(TestIds.DeviceA);

        (await LoadAuditAsync()).Select(a => a.Action)
            .ShouldContain(AdminAuditActions.DeviceRevoked);
    }

    [Fact]
    public async Task Revoking_twice_is_the_same_answer_as_revoking_once()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var first = await owner.Delete($"/api/devices/{TestIds.DeviceA}");
        var second = await owner.Delete($"/api/devices/{TestIds.DeviceA}");

        first.StatusCode.ShouldBe(HttpStatusCode.OK);
        second.StatusCode.ShouldBe(HttpStatusCode.OK);

        // The second call did not re-stamp: an already-revoked phone keeps the moment it was
        // actually taken away, which is the only version of that timestamp worth having in an
        // audit conversation.
        var revokedAt = (await LoadDevicesAsync(TestIds.WorkerA)).ShouldHaveSingleItem().RevokedAt;

        revokedAt.ShouldNotBeNull();
        revokedAt.Value.ShouldBe(
            (await first.JsonAsync()).GetProperty("revoked_at").GetDateTimeOffset().UtcDateTime,
            TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task Revoking_another_companys_phone_is_404_and_leaves_it_running()
    {
        await GivenCompanyBWorkerAsync(withDevice: true);
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.Delete($"/api/devices/{TestIds.DeviceB}");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        response.StatusCode.ShouldNotBe(HttpStatusCode.Forbidden);

        (await LoadDevicesAsync(TestIds.WorkerB)).ShouldHaveSingleItem()
            .RevokedAt.ShouldBeNull();
    }

    // ------------------------------------------------------------ helpers

    private const string CompanyBToken = "teren-test-device-token-company-b";

    private async Task GivenCompanyBWorkerAsync(bool withDevice = false)
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

        if (withDevice)
        {
            identity.Devices.Add(new Device
            {
                Id = TestIds.DeviceB,
                CompanyId = TestIds.CompanyB,
                UserId = TestIds.WorkerB,
                Name = "Nenadov telefon",
                TokenHash = CredentialTokens.Hash(CompanyBToken),
                CreatedAt = now,
            });
        }

        await identity.SaveChangesAsync(Ct);
    }

    private async Task<string> CreateWorkerAsync(HttpClient owner, string displayName)
    {
        var response = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = displayName });

        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());

        return (await response.JsonAsync()).GetProperty("worker").GetText("username");
    }
}
