using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Maintenance;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// <c>invite-admin</c>: the only thing in the product that ever <em>creates</em> a
/// <c>password_token</c>.
/// <para>
/// <b>The test that carries this file is
/// <see cref="It_mints_a_link_that_completes_the_chain_that_was_broken"/></b>, because it walks
/// the exact sequence that could not be walked before this command existed and that had to be
/// done by hand in psql: mint → <c>POST /auth/password</c> → <c>POST /auth/login</c> →
/// <c>GET /api/workers</c>. Every other test in the file guards one edge of it.
/// </para>
/// <para>
/// Every test that needs a token <b>reads it out of the command's printed output</b>, never out
/// of the database — the token is only ever printed once, so what the founder can copy off his
/// terminal is the thing that has to work. A test that reached into <c>password_token</c> would
/// prove the row exists and nothing about the credential in his hand.
/// </para>
/// </summary>
public sealed class InviteAdminCommandTests(TerenTestApp app) : ApiTestBase(app)
{
    private const string ChosenPassword = "a-passphrase-he-picked-himself";

    /// <summary>
    /// A worker who <em>does</em> have an address on file — optional but the normal case (§2
    /// decision 6). The fixture's own worker has none, and a refusal that could only be reached
    /// by an address nobody has would prove nothing.
    /// </summary>
    private const string WorkerEmail = "zoran.jovanovic@vodoinstal-petrovic.test";

    [Fact]
    public async Task It_mints_a_link_that_completes_the_chain_that_was_broken()
    {
        // An invited company admin, exactly as DemoSeeder leaves one: the row exists, the
        // password_hash is NULL, and before this command nothing could ever fill it in.
        var admin = await GivenCompanyAdminAsync(withPassword: false);

        var (exit, output) = await RunAsync(["--email", admin.Email!]);

        exit.ShouldBe(0);

        var token = TokenIn(output);

        // 1. He sets his own password with the token off the founder's terminal.
        var set = await SetPasswordAsync(token, ChosenPassword);
        set.StatusCode.ShouldBe(HttpStatusCode.OK, await set.TextAsync());
        (await set.JsonAsync()).GetText("email").ShouldBe(admin.Email);

        // 2. A company_admin session now exists — which is the thing that could not exist.
        using var signedIn = await SignInAsync(admin.Email!, ChosenPassword);

        // 3. And it reaches the surface that issues activation codes. This is the link the whole
        //    chain hangs from: no admin session, no POST /api/workers/{id}/activation-code, no
        //    code for any worker anywhere.
        var workers = await signedIn.Get("/api/workers");
        workers.StatusCode.ShouldBe(HttpStatusCode.OK, await workers.TextAsync());

        var issued = await signedIn.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code");
        issued.StatusCode.ShouldBe(HttpStatusCode.OK, await issued.TextAsync());
        (await issued.JsonAsync()).GetText("code").Length.ShouldBeGreaterThan(0);
    }

    [Fact]
    public async Task The_purpose_is_invite_for_an_account_that_has_never_had_a_password()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);

        var (_, output) = await RunAsync(["--email", admin.Email!]);

        output.ShouldContain("Purpose: invite");
        (await LiveTokensAsync(admin.Id)).ShouldHaveSingleItem()
            .Purpose.ShouldBe(PasswordTokenPurpose.Invite);
    }

    [Fact]
    public async Task The_purpose_is_reset_for_an_account_that_already_has_one()
    {
        // And the current password keeps working until the link is actually used: minting is not
        // a withdrawal. Anything else would make "send him a reset" a way to lock a customer out
        // of his own reports by accident.
        var admin = await GivenCompanyAdminAsync();

        var (_, output) = await RunAsync(["--email", admin.Email!]);

        output.ShouldContain("Purpose: reset");
        (await LiveTokensAsync(admin.Id)).ShouldHaveSingleItem()
            .Purpose.ShouldBe(PasswordTokenPurpose.Reset);

        using var stillWorks = await SignInAsync(admin.Email!);
        (await stillWorks.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);

        await SetPasswordAsync(TokenIn(output), ChosenPassword);

        using var anonymous = App.CreateAnonymousClient();
        var old = await anonymous.PostJson(
            "/auth/login",
            new JsonObject { ["email"] = admin.Email, ["password"] = AdminPassword });
        old.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Re_running_supersedes_the_previous_link_rather_than_leaving_two_live()
    {
        // THE MUTATION TARGET. password_token has no ux_password_token_live — unlike
        // activation_code, the database does NOT refuse a second live row — so nothing but this
        // statement stops "it never arrived, send another" from leaving the first link valid for
        // another 48 hours in whatever inbox it did arrive in.
        var admin = await GivenCompanyAdminAsync(withPassword: false);

        var (_, first) = await RunAsync(["--email", admin.Email!]);
        var (_, second) = await RunAsync(["--email", admin.Email!]);

        // The behaviour first, so a mutation is caught by what the link DOES and not merely by
        // what the command printed about it.
        (await SetPasswordAsync(TokenIn(first), ChosenPassword)).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);

        (await SetPasswordAsync(TokenIn(second), ChosenPassword)).StatusCode
            .ShouldBe(HttpStatusCode.OK);

        second.ShouldContain("Superseded 1 earlier link");

        // Two rows exist — nothing is deleted — but only one of them was ever live at a time.
        (await AllTokensAsync(admin.Id)).Count.ShouldBe(2);
    }

    [Fact]
    public async Task A_minted_token_is_single_use()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        var (_, output) = await RunAsync(["--email", admin.Email!]);
        var token = TokenIn(output);

        (await SetPasswordAsync(token, ChosenPassword)).StatusCode.ShouldBe(HttpStatusCode.OK);

        (await SetPasswordAsync(token, "some-other-passphrase")).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);

        // And the second attempt changed nothing.
        using var signedIn = await SignInAsync(admin.Email!, ChosenPassword);
        (await signedIn.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task An_expired_token_is_refused()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);

        var (exit, output) = await RunAsync(
            ["--email", admin.Email!], lifetime: TimeSpan.FromSeconds(-1));

        exit.ShouldBe(0);

        (await SetPasswordAsync(TokenIn(output), ChosenPassword)).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);

        (await LoadUserAsync(admin.Id))!.PasswordHash.ShouldBeNull();
    }

    [Fact]
    public async Task The_lifetime_comes_from_the_configured_option()
    {
        // Not a literal in the command: /auth/password measures the token against expires_at, and
        // "how long is a link good for" has to have one answer. Auth:PasswordTokenLifetime is
        // validated (5 minutes to 30 days) and defaults to 48 hours.
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        var before = DateTime.UtcNow;

        await RunAsync(["--email", admin.Email!], lifetime: TimeSpan.FromHours(48));

        var token = (await LiveTokensAsync(admin.Id)).ShouldHaveSingleItem();

        token.ExpiresAt.ShouldBeInRange(
            before.AddHours(48).AddSeconds(-30), DateTime.UtcNow.AddHours(48).AddSeconds(30));
    }

    [Fact]
    public async Task It_refuses_a_worker_rather_than_minting_a_link_that_cannot_work()
    {
        // ck_app_user_worker_has_no_password makes a worker password unstorable and
        // SetPasswordAsync refuses one anyway, so a token minted here would be dead on arrival —
        // discovered by the man it was handed to. Refusing names the reason while somebody can
        // still act on it.
        await GiveWorkerAnAddressAsync();

        var (exit, output) = await RunAsync(["--email", WorkerEmail]);

        exit.ShouldBe(2);
        output.ShouldContain("is a worker");
        output.ShouldContain("ck_app_user_worker_has_no_password");

        (await AllTokensAsync(TestIds.WorkerA)).ShouldBeEmpty();
    }

    [Fact]
    public async Task It_refuses_an_unknown_email_and_writes_nothing()
    {
        var (exit, output) = await RunAsync(["--email", "nobody@teren.test"]);

        exit.ShouldBe(2);
        output.ShouldContain("does not create accounts");

        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.CountAsync(Ct)).ShouldBe(0);
        (await identity.Users.CountAsync(u => u.Email == "nobody@teren.test", Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task It_refuses_a_disabled_admin_and_does_not_re_enable_him()
    {
        // CreateSuperAdminCommand clears disabled_at because that command IS the founder's way
        // back into his own product. Re-enabling a *customer's* admin from a shell is an
        // administrative act on somebody else's company and belongs on the platform surface,
        // where it gets an actor and an audit row naming him.
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        await DisableAsync(admin.Id);

        var (exit, output) = await RunAsync(["--email", admin.Email!]);

        exit.ShouldBe(2);
        output.ShouldContain("is disabled");

        (await LoadUserAsync(admin.Id))!.DisabledAt.ShouldNotBeNull();
        (await AllTokensAsync(admin.Id)).ShouldBeEmpty();
    }

    [Fact]
    public async Task It_refuses_an_admin_whose_company_is_suspended()
    {
        // POST /auth/password does not look at the company, so the token would be accepted — and
        // then POST /auth/login would refuse the brand-new password with the same deliberately
        // uninformative 401 as a wrong one. The customer would have set a password that does not
        // work and nobody could say why.
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        await SuspendCompanyAsync(TestIds.CompanyA);

        var (exit, output) = await RunAsync(["--email", admin.Email!]);

        exit.ShouldBe(2);
        output.ShouldContain("suspended");
        (await AllTokensAsync(admin.Id)).ShouldBeEmpty();
    }

    [Fact]
    public async Task It_invites_teren_staff_too()
    {
        // Both admin roles, because POST /auth/password admits any non-worker with an address and
        // a rule that lived only in this command would be a rule nobody could find.
        var staff = await GivenSuperAdminAsync();

        var (exit, output) = await RunAsync(["--email", staff.Email!]);

        exit.ShouldBe(0);
        (await SetPasswordAsync(TokenIn(output), ChosenPassword)).StatusCode
            .ShouldBe(HttpStatusCode.OK);

        using var signedIn = await SignInAsync(staff.Email!, ChosenPassword);
        (await signedIn.Get("/api/me")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_printed_token_is_never_what_the_database_stores()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);

        var (_, output) = await RunAsync(["--email", admin.Email!]);
        var token = TokenIn(output);

        var row = (await LiveTokensAsync(admin.Id)).ShouldHaveSingleItem();

        token.ShouldStartWith(CredentialTokens.PasswordPrefix);
        row.TokenHash.ShouldNotContain(token);
        row.TokenHash.ShouldBe(CredentialTokens.Hash(token));
        output.ShouldContain("PRINTED ONCE");
    }

    [Fact]
    public async Task It_writes_an_audit_row_naming_the_console()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);

        await RunAsync(["--email", admin.Email!]);

        var audit = (await LoadAuditAsync()).ShouldHaveSingleItem();

        audit.Action.ShouldBe(AdminAuditActions.PasswordTokenIssued);
        audit.SubjectId.ShouldBe(admin.Id);
        audit.CompanyId.ShouldBe(TestIds.CompanyA);
        audit.Detail.ShouldNotBeNull();
        audit.Detail.ShouldContain("console");
        audit.Detail.ShouldContain("invite");
    }

    [Theory]
    [InlineData("--email", "not-an-address")]
    [InlineData("--email", "")]
    [InlineData("--email")]                              // the flag with nothing after it
    public async Task It_refuses_a_malformed_invocation_and_writes_nothing(params string[] flags)
    {
        var (exit, _) = await RunAsync(flags);

        exit.ShouldBe(2);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.CountAsync(Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task It_refuses_a_bare_invocation_with_no_email_at_all()
    {
        var (exit, output) = await RunAsync([]);

        exit.ShouldBe(2);
        output.ShouldContain("--email is required");

        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.CountAsync(Ct)).ShouldBe(0);
    }

    [Fact]
    public void It_neither_creates_an_account_nor_writes_a_password()
    {
        // A source scan rather than a behaviour test, on purpose, and for the same reason
        // CreateSuperAdminCommandTests scans for "--password": both additions would be small,
        // would work perfectly, and would quietly move the ability to conjure a privileged
        // account — or to choose somebody else's password — into a shell with no actor and no
        // reviewed surface. Creating companies and admins is D4's platform surface (§8).
        var command = SourceTree.Files()
            .Single(f => Path.GetFileName(f) == "InviteAdminCommand.cs");

        var code = SourceTree.CodeOf(command);

        code.ShouldNotContain("Users.Add");
        code.ShouldNotContain("PasswordHash.Hash");
        code.ShouldNotContain("Console.ReadLine");

        // And it really does mint one, so the assertions above are not passing over a file that
        // stopped doing anything.
        code.ShouldContain("PasswordTokens.Add");
    }

    // ------------------------------------------------------------------- drivers

    /// <summary>
    /// Drives the command against the suite's own database, exactly as <c>Program.cs</c> does,
    /// and returns its exit code together with everything it printed.
    /// </summary>
    private async Task<(int Exit, string Output)> RunAsync(
        string[] args, TimeSpan? lifetime = null, string appUrl = "")
    {
        await using var identity = App.CreateIdentityDbContext();
        var output = new StringWriter();

        var exit = await InviteAdminCommand.RunAsync(
            identity,
            [InviteAdminCommand.CommandName, .. args],
            output,
            lifetime ?? TimeSpan.FromHours(48),
            appUrl,
            Ct);

        return (exit, output.ToString());
    }

    /// <summary>
    /// The token as the founder reads it off his terminal — one line, <c>token: trn_p_…</c>.
    /// Parsing the printed output rather than the row is the point: a printed credential that
    /// cannot be copied back out is not a credential.
    /// </summary>
    private static string TokenIn(string output)
    {
        var line = output.Split('\n')
            .Select(l => l.Trim())
            .FirstOrDefault(l => l.StartsWith("token: ", StringComparison.Ordinal));

        line.ShouldNotBeNull($"the command printed no token line:\n{output}");

        return line["token: ".Length..].Trim();
    }

    private async Task<HttpResponseMessage> SetPasswordAsync(string token, string password)
    {
        using var anonymous = App.CreateAnonymousClient();

        return await anonymous.PostJson(
            "/auth/password",
            new JsonObject { ["token"] = token, ["password"] = password });
    }

    private async Task<List<PasswordToken>> AllTokensAsync(Guid userId)
    {
        await using var identity = App.CreateIdentityDbContext();
        return await identity.PasswordTokens.AsNoTracking()
            .Where(t => t.UserId == userId)
            .OrderBy(t => t.CreatedAt)
            .ToListAsync(Ct);
    }

    private async Task<List<PasswordToken>> LiveTokensAsync(Guid userId) =>
        [.. (await AllTokensAsync(userId))
            .Where(t => t.ConsumedAt is null && t.SupersededAt is null)];

    private async Task GiveWorkerAnAddressAsync()
    {
        await using var identity = App.CreateIdentityDbContext();
        await identity.Users
            .Where(u => u.Id == TestIds.WorkerA)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.Email, WorkerEmail), Ct);
    }

    private async Task DisableAsync(Guid userId)
    {
        await using var identity = App.CreateIdentityDbContext();
        await identity.Users
            .Where(u => u.Id == userId)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.DisabledAt, DateTime.UtcNow), Ct);
    }

    private async Task SuspendCompanyAsync(Guid companyId)
    {
        await using var identity = App.CreateIdentityDbContext();
        await identity.Companies
            .Where(c => c.Id == companyId)
            .ExecuteUpdateAsync(c => c.SetProperty(x => x.SuspendedAt, DateTime.UtcNow), Ct);
    }
}
