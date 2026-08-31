using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// <c>POST /auth/login</c>, and the session token it issues.
/// <para>
/// <b>The property that matters most here is that login is not an account-enumeration oracle.</b>
/// A codebase that goes to the trouble of making a foreign media id 404 rather than 409 cannot
/// then hand out a customer list through a login form — not by status code, not by body, and not
/// by stopwatch.
/// </para>
/// </summary>
public sealed class LoginTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task A_company_admin_signs_in_and_the_token_works_on_the_api()
    {
        var admin = await GivenCompanyAdminAsync();

        var response = await Login(admin.Email!, AdminPassword);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var body = await response.JsonAsync();
        body.GetText("role").ShouldBe(AppUserRoleNames.CompanyAdmin);
        body.GetGuid("user_id").ShouldBe(admin.Id);
        body.GetText("display_name").ShouldBe(admin.DisplayName);
        body.GetProperty("company").GetGuid("id").ShouldBe(TestIds.CompanyA);
        body.GetText("session_token").ShouldStartWith(CredentialTokens.SessionPrefix);

        // The end that matters: the token authenticates against the real API, through the real
        // filter, resolving to the real tenant.
        using var signedIn = App.CreateClientWithToken(body.GetText("session_token"));
        (await signedIn.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_plaintext_password_is_never_stored()
    {
        var admin = await GivenCompanyAdminAsync();

        var stored = (await LoadUserAsync(admin.Id))!.PasswordHash;

        stored.ShouldNotBeNull();
        stored.ShouldNotContain(AdminPassword);
        stored.ShouldStartWith(PasswordHash.Algorithm + "$" + PasswordHash.Iterations);
    }

    [Fact]
    public async Task A_super_admins_session_is_much_shorter_than_a_company_admins()
    {
        // Eight hours against thirty days (§5). This session can enumerate every customer, so it
        // is deliberately about the length of a working day — and the difference is a security
        // parameter, not a preference, so it is asserted rather than assumed.
        await GivenCompanyAdminAsync();
        await GivenSuperAdminAsync();

        var owner = await (await Login(TestIds.CompanyAdminAEmail, AdminPassword)).JsonAsync();
        var staff = await (await Login(TestIds.SuperAdminEmail, AdminPassword)).JsonAsync();

        var ownerExpiry = DateTimeOffset.Parse(owner.GetText("expires_at"));
        var staffExpiry = DateTimeOffset.Parse(staff.GetText("expires_at"));

        (ownerExpiry - DateTimeOffset.UtcNow).TotalDays.ShouldBeGreaterThan(25);
        (staffExpiry - DateTimeOffset.UtcNow).TotalHours.ShouldBeInRange(7, 9);
        staff.IsNull("company").ShouldBeTrue();
    }

    // ------------------------------------------------------------ no oracle

    [Fact]
    public async Task An_unknown_email_and_a_wrong_password_are_indistinguishable()
    {
        await GivenCompanyAdminAsync();

        var wrongPassword = await Login(TestIds.CompanyAdminAEmail, "not-the-password-at-all");
        var unknownEmail = await Login("nobody@nowhere.test", "not-the-password-at-all");

        wrongPassword.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        (await RejectionFingerprint.OfAsync(unknownEmail))
            .ShouldBe(await RejectionFingerprint.OfAsync(wrongPassword));
    }

    [Fact]
    public async Task A_disabled_admin_and_a_suspended_company_answer_the_same_way()
    {
        // Both are withdrawals of an otherwise-good credential, and both must look exactly like a
        // wrong password: "your account is disabled" tells an attacker the address is real.
        await GivenCompanyAdminAsync();
        var wrongPassword = await Login(TestIds.CompanyAdminAEmail, "not-the-password-at-all");
        var reference = await RejectionFingerprint.OfAsync(wrongPassword);

        await using (var identity = App.CreateIdentityDbContext())
        {
            var admin = await identity.Users.SingleAsync(u => u.Id == TestIds.CompanyAdminA, Ct);
            admin.DisabledAt = DateTime.UtcNow;
            await identity.SaveChangesAsync(Ct);
        }

        var disabled = await Login(TestIds.CompanyAdminAEmail, AdminPassword);
        (await RejectionFingerprint.OfAsync(disabled)).ShouldBe(reference);

        await App.ResetAsync();
        await GivenCompanyAdminAsync();

        await using (var db = App.CreateDbContext(companyId: null))
        {
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE company SET suspended_at = now() WHERE id = {TestIds.CompanyA}", Ct);
        }

        var suspended = await Login(TestIds.CompanyAdminAEmail, AdminPassword);
        (await RejectionFingerprint.OfAsync(suspended)).ShouldBe(reference);
    }

    [Fact]
    public async Task A_worker_cannot_sign_in_even_with_an_address_on_file()
    {
        // There is exactly one door into the diary and it is the device. A worker can never hold a
        // password (ck_app_user_worker_has_no_password), so this row falls down the same branch an
        // unknown address does — including the dummy verify, so it costs the same wall clock.
        await using (var identity = App.CreateIdentityDbContext())
        {
            var worker = await identity.Users.SingleAsync(u => u.Id == TestIds.WorkerA, Ct);
            worker.Email = "zoran@vodoinstal-petrovic.test";
            await identity.SaveChangesAsync(Ct);
        }

        var response = await Login("zoran@vodoinstal-petrovic.test", AdminPassword);

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_admin_who_has_never_set_a_password_cannot_sign_in()
    {
        // password_hash IS NULL is the "invited, not yet onboarded" state (§8: status=pending).
        // It must not be a way in.
        await GivenCompanyAdminAsync(withPassword: false);

        var response = await Login(TestIds.CompanyAdminAEmail, AdminPassword);

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Email_is_matched_case_insensitively_and_with_surrounding_space_ignored()
    {
        // Normalise-on-write, matched by normalise-on-read: the CHECK constraint guarantees the
        // stored value is lower(btrim(...)), so the lookup has to do the same or a customer typing
        // his own address with a capital letter cannot sign in.
        await GivenCompanyAdminAsync();

        var response = await Login("  PETAR@Vodoinstal-Petrovic.TEST  ", AdminPassword);

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
    }

    [Fact]
    public async Task The_presented_password_is_never_echoed_back()
    {
        await GivenCompanyAdminAsync();

        var response = await Login(TestIds.CompanyAdminAEmail, "hunter2-was-my-password");

        (await response.TextAsync()).ShouldNotContain("hunter2");
    }

    // ------------------------------------------------------------ sessions

    [Fact]
    public async Task Signing_out_kills_this_session_and_leaves_the_others_alone()
    {
        await GivenCompanyAdminAsync();

        using var first = await SignInAsync(TestIds.CompanyAdminAEmail);
        using var second = await SignInAsync(TestIds.CompanyAdminAEmail);

        (await first.PostNothing("/api/auth/logout")).StatusCode
            .ShouldBe(HttpStatusCode.NoContent);

        (await first.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await second.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_revoked_session_stops_on_its_very_next_request()
    {
        // The same no-cache property the device path has, stated for sessions. NO await Task.Delay
        // anywhere: the absence of the sleep is the assertion, exactly as in DeviceCredentialTests.
        await GivenCompanyAdminAsync();
        using var client = await SignInAsync(TestIds.CompanyAdminAEmail);

        (await client.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);

        await using (var identity = App.CreateIdentityDbContext())
        {
            await identity.AdminSessions
                .Where(s => s.UserId == TestIds.CompanyAdminA)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.RevokedAt, DateTime.UtcNow), Ct);
        }

        (await client.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_expired_session_stops_working_the_moment_it_expires()
    {
        await GivenCompanyAdminAsync();
        using var client = await SignInAsync(TestIds.CompanyAdminAEmail);

        await using (var identity = App.CreateIdentityDbContext())
        {
            // Moved back in time rather than waited out — the shipped lifetime is thirty days.
            await identity.AdminSessions
                .Where(s => s.UserId == TestIds.CompanyAdminA)
                .ExecuteUpdateAsync(
                    u => u.SetProperty(s => s.ExpiresAt, DateTime.UtcNow.AddSeconds(-1)), Ct);
        }

        (await client.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Signing_in_stamps_last_login_at()
    {
        var admin = await GivenCompanyAdminAsync();
        (await LoadUserAsync(admin.Id))!.LastLoginAt.ShouldBeNull();

        await SignInAsync(admin.Email!);

        (await LoadUserAsync(admin.Id))!.LastLoginAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task A_session_token_is_stored_only_as_a_hash()
    {
        await GivenCompanyAdminAsync();

        var body = await (await Login(TestIds.CompanyAdminAEmail, AdminPassword)).JsonAsync();
        var token = body.GetText("session_token");

        await using var identity = App.CreateIdentityDbContext();
        var session = await identity.AdminSessions.SingleAsync(Ct);

        session.TokenHash.ShouldBe(CredentialTokens.Hash(token));
        session.TokenHash.ShouldNotContain(token);
    }

    private async Task<HttpResponseMessage> Login(string email, string password)
    {
        using var anonymous = App.CreateAnonymousClient();

        return await anonymous.PostJson(
            "/auth/login",
            new JsonObject { ["email"] = email, ["password"] = password });
    }
}
