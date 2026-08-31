using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// <c>POST /auth/password</c> — one route serving both the invite (first password) and the reset
/// (replacement), because they are the same machinery with a different reason (§8).
/// <para>
/// The route that <em>issues</em> these tokens is the platform surface and lands at D4; until then
/// they are written directly, which is also exactly what the authenticated escape hatch in §9 will
/// do when there is no relay configured.
/// </para>
/// </summary>
public sealed class SetPasswordTests(TerenTestApp app) : ApiTestBase(app)
{
    private const string NewPassword = "a-brand-new-passphrase";

    [Fact]
    public async Task An_invited_admin_sets_a_password_and_can_then_sign_in()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Invite);

        var response = await SetPassword(token, NewPassword);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var body = await response.JsonAsync();
        body.GetText("email").ShouldBe(admin.Email);
        body.GetText("role").ShouldBe(AppUserRoleNames.CompanyAdmin);

        using var signedIn = await SignInAsync(admin.Email!, NewPassword);
        (await signedIn.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Setting_a_password_ends_every_session_opened_with_the_old_one()
    {
        // A reset exists precisely for the case where somebody else may hold a credential, so
        // leaving his sessions alive would defeat the point of resetting.
        var admin = await GivenCompanyAdminAsync();
        using var stale = await SignInAsync(admin.Email!);
        (await stale.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Reset);
        await SetPassword(token, NewPassword);

        (await stale.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_old_password_stops_working()
    {
        var admin = await GivenCompanyAdminAsync();
        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Reset);

        await SetPassword(token, NewPassword);

        using var anonymous = App.CreateAnonymousClient();
        var response = await anonymous.PostJson(
            "/auth/login",
            new JsonObject { ["email"] = admin.Email, ["password"] = AdminPassword });

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_token_is_single_use()
    {
        // THE MUTATION TARGET. Drop `consumed_at IS NULL` from the conditional claim and this
        // turns red — after which a reset link forwarded in an email thread is a permanent key to
        // a customer's account.
        var admin = await GivenCompanyAdminAsync();
        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Reset);

        (await SetPassword(token, NewPassword)).StatusCode.ShouldBe(HttpStatusCode.OK);

        var second = await SetPassword(token, "yet-another-passphrase");

        second.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // And the second attempt changed nothing.
        using var signedIn = await SignInAsync(admin.Email!, NewPassword);
        (await signedIn.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task An_expired_token_is_refused()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        var token = await GivenPasswordTokenAsync(
            admin.Id, PasswordTokenPurpose.Invite, expiresAt: DateTime.UtcNow.AddSeconds(-1));

        (await SetPassword(token, NewPassword)).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);

        (await LoadUserAsync(admin.Id))!.PasswordHash.ShouldBeNull();
    }

    [Fact]
    public async Task An_unknown_token_and_a_consumed_one_answer_identically()
    {
        var admin = await GivenCompanyAdminAsync();
        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Reset);
        await SetPassword(token, NewPassword);

        var consumed = await SetPassword(token, NewPassword);
        var unknown = await SetPassword("trn_p_this-token-was-never-issued", NewPassword);

        (await RejectionFingerprint.OfAsync(unknown))
            .ShouldBe(await RejectionFingerprint.OfAsync(consumed));
    }

    [Fact]
    public async Task A_short_password_is_refused_before_the_token_is_burned()
    {
        // The asymmetry with login is deliberate: the caller holds a single-use token issued for
        // his own account, so telling him the password is too short costs nothing — and burning
        // his one token on a typo would cost him a support call.
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Invite);

        var response = await SetPassword(token, "short");
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        (await SetPassword(token, NewPassword)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_worker_cannot_be_given_a_password_by_this_route()
    {
        // There is exactly one door into the diary, and the database agrees:
        // ck_app_user_worker_has_no_password. Refusing here means the answer is a 401 rather than
        // a 500 out of a CHECK constraint.
        var token = await GivenPasswordTokenAsync(TestIds.WorkerA, PasswordTokenPurpose.Invite);

        var response = await SetPassword(token, NewPassword);

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await LoadUserAsync(TestIds.WorkerA))!.PasswordHash.ShouldBeNull();
    }

    [Fact]
    public async Task A_disabled_admin_cannot_set_a_password()
    {
        var admin = await GivenCompanyAdminAsync();
        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Reset);

        await using (var identity = App.CreateIdentityDbContext())
        {
            await identity.Users
                .Where(u => u.Id == admin.Id)
                .ExecuteUpdateAsync(
                    u => u.SetProperty(x => x.DisabledAt, DateTime.UtcNow), Ct);
        }

        (await SetPassword(token, NewPassword)).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_new_password_is_never_stored_in_the_clear()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        var token = await GivenPasswordTokenAsync(admin.Id, PasswordTokenPurpose.Invite);

        await SetPassword(token, NewPassword);

        var stored = (await LoadUserAsync(admin.Id))!.PasswordHash!;

        stored.ShouldNotContain(NewPassword);
        PasswordHash.Verify(NewPassword, stored).ShouldBeTrue();
    }

    private async Task<HttpResponseMessage> SetPassword(string token, string password)
    {
        using var anonymous = App.CreateAnonymousClient();

        return await anonymous.PostJson(
            "/auth/password",
            new JsonObject { ["token"] = token, ["password"] = password });
    }

    /// <summary>
    /// Writes an invite or reset token directly, which is what the D4 platform route and the §9
    /// no-relay escape hatch will both do. Returns the plaintext, which exists only here and in
    /// the caller's hands — the database keeps its SHA-256 and nothing else.
    /// </summary>
    private async Task<string> GivenPasswordTokenAsync(
        Guid userId, PasswordTokenPurpose purpose, DateTime? expiresAt = null)
    {
        var token = CredentialTokens.New(CredentialTokens.PasswordPrefix);

        await using var identity = App.CreateIdentityDbContext();

        identity.PasswordTokens.Add(new PasswordToken
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Purpose = purpose,
            TokenHash = CredentialTokens.Hash(token),
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = expiresAt ?? DateTime.UtcNow.AddHours(48),
        });

        await identity.SaveChangesAsync(Ct);

        return token;
    }
}
