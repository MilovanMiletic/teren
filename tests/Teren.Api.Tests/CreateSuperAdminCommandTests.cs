using System.Net;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Maintenance;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// <c>create-super-admin</c>: the bootstrap for the first Teren staff account, because there is
/// nobody to invite him.
/// <para>
/// <b>The password is read from stdin and never from argv, and that is the whole reason this is a
/// command rather than a flag.</b> An argument lands in shell history, in <c>ps</c> output for
/// every user on the box, and in the process listing of any monitoring agent running there. The
/// test that matters most in this file is the one that reads the source and proves no argument
/// named for a password exists at all.
/// </para>
/// </summary>
public sealed class CreateSuperAdminCommandTests(TerenTestApp app) : ApiTestBase(app)
{
    private const string Password = "a-long-enough-console-passphrase";

    [Fact]
    public void The_password_is_never_an_argument()
    {
        // THE MUTATION TARGET, and it is a source scan rather than a behaviour test on purpose:
        // adding `--password` would be a convenience that works perfectly and quietly writes the
        // most privileged credential in the product into ~/.bash_history.
        var command = SourceTree.Files()
            .Single(f => Path.GetFileName(f) == "CreateSuperAdminCommand.cs");

        var code = SourceTree.CodeOf(command);

        code.ShouldNotContain("\"--password\"");
        code.ShouldNotContain("\"--pass\"");
        code.ShouldNotContain("\"--pwd\"");

        // And it really does read stdin, so the assertions above are not passing over a file that
        // stopped reading a password at all.
        code.ShouldContain("input.ReadLine()");
    }

    [Fact]
    public async Task It_creates_a_super_admin_who_can_then_sign_in()
    {
        var exit = await RunAsync(
            ["create-super-admin", "--email", "  Founder@Teren.RS ", "--name", "Milovan"],
            Password);

        exit.ShouldBe(0);

        await using var identity = App.CreateIdentityDbContext();
        var user = await identity.Users.SingleAsync(u => u.Email == "founder@teren.rs", Ct);

        user.Role.ShouldBe(AppUserRole.SuperAdmin);
        // NULL, and the database insists: ck_app_user_company_scope makes a super admin inside a
        // tenant unrepresentable, which is what layer 2 of the privacy claim rests on.
        user.CompanyId.ShouldBeNull();
        user.Username.ShouldBeNull();
        user.DisplayName.ShouldBe("Milovan");
        PasswordHash.Verify(Password, user.PasswordHash).ShouldBeTrue();

        using var staff = await SignInAsync("founder@teren.rs", Password);
        (await staff.Get("/api/me")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task It_writes_an_audit_row_naming_the_console()
    {
        await RunAsync(
            ["create-super-admin", "--email", "founder@teren.rs", "--name", "Milovan"], Password);

        var audit = (await LoadAuditAsync()).ShouldHaveSingleItem();

        audit.Action.ShouldBe(AdminAuditActions.SuperAdminCreated);
        audit.CompanyId.ShouldBeNull();
        audit.Detail.ShouldNotBeNull();
        audit.Detail.ShouldContain("console");
    }

    [Fact]
    public async Task It_refuses_a_second_run_rather_than_silently_resetting_a_password()
    {
        await RunAsync(
            ["create-super-admin", "--email", "founder@teren.rs", "--name", "Milovan"], Password);

        var output = new StringWriter();
        var exit = await RunAsync(
            ["create-super-admin", "--email", "founder@teren.rs", "--name", "Milovan"],
            "a-different-long-passphrase",
            output);

        exit.ShouldBe(2);
        output.ToString().ShouldContain(CreateSuperAdminCommand.ResetPasswordFlag);

        await using var identity = App.CreateIdentityDbContext();
        var user = await identity.Users.SingleAsync(u => u.Email == "founder@teren.rs", Ct);
        PasswordHash.Verify(Password, user.PasswordHash).ShouldBeTrue();
    }

    [Fact]
    public async Task With_the_flag_it_resets_the_password_and_revokes_every_session()
    {
        // The way back when the founder is locked out of his own product at 9 p.m. with no relay
        // configured — and it ends his old sessions, for the same reason /auth/password does.
        await RunAsync(
            ["create-super-admin", "--email", "founder@teren.rs", "--name", "Milovan"], Password);

        using var stale = await SignInAsync("founder@teren.rs", Password);
        (await stale.Get("/api/me")).StatusCode.ShouldBe(HttpStatusCode.OK);

        var exit = await RunAsync(
            [
                "create-super-admin", "--email", "founder@teren.rs", "--name", "Milovan",
                CreateSuperAdminCommand.ResetPasswordFlag,
            ],
            "a-different-long-passphrase");

        exit.ShouldBe(0);

        (await stale.Get("/api/me")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        using var fresh = await SignInAsync("founder@teren.rs", "a-different-long-passphrase");
        (await fresh.Get("/api/me")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task It_will_not_promote_an_existing_customer_admin()
    {
        // Promoting a customer's admin would move him outside every tenant filter in the product,
        // from a shell, with no audit trail worth the name.
        await GivenCompanyAdminAsync();

        var output = new StringWriter();
        var exit = await RunAsync(
            [
                "create-super-admin", "--email", TestIds.CompanyAdminAEmail, "--name", "Petar",
                CreateSuperAdminCommand.ResetPasswordFlag,
            ],
            Password,
            output);

        exit.ShouldBe(2);
        output.ToString().ShouldContain("will not change an existing account's role");

        (await LoadUserAsync(TestIds.CompanyAdminA))!.Role.ShouldBe(AppUserRole.CompanyAdmin);
    }

    [Theory]
    [InlineData("--name", "Milovan")]                                    // no --email
    [InlineData("--email", "not-an-address", "--name", "Milovan")]
    [InlineData("--email", "founder@teren.rs")]                          // no --name
    public async Task It_refuses_a_malformed_invocation_and_writes_nothing(params string[] flags)
    {
        var exit = await RunAsync(["create-super-admin", .. flags], Password);

        exit.ShouldBe(2);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.Users.CountAsync(u => u.Role == AppUserRole.SuperAdmin, Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task It_refuses_a_password_that_is_too_short()
    {
        var output = new StringWriter();
        var exit = await RunAsync(
            ["create-super-admin", "--email", "founder@teren.rs", "--name", "Milovan"],
            "short",
            output);

        exit.ShouldBe(2);
        output.ToString().ShouldContain("at least 12 characters");

        await using var identity = App.CreateIdentityDbContext();
        (await identity.Users.CountAsync(u => u.Role == AppUserRole.SuperAdmin, Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task It_refuses_an_empty_stdin_rather_than_creating_a_passwordless_account()
    {
        var exit = await RunAsync(
            ["create-super-admin", "--email", "founder@teren.rs", "--name", "Milovan"],
            string.Empty);

        exit.ShouldBe(2);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.Users.CountAsync(u => u.Role == AppUserRole.SuperAdmin, Ct)).ShouldBe(0);
    }

    /// <summary>
    /// Drives the command against the suite's own database with a piped password, which is exactly
    /// the shape a deploy script uses: <c>printf '%s\n' "$PW" | dotnet run -- create-super-admin
    /// …</c>. <c>maskInput: false</c> because there is no console to read keys from.
    /// </summary>
    private async Task<int> RunAsync(string[] args, string password, TextWriter? output = null)
    {
        await using var identity = App.CreateIdentityDbContext();

        return await CreateSuperAdminCommand.RunAsync(
            identity,
            args,
            new StringReader(password + Environment.NewLine),
            output ?? TextWriter.Null,
            maskInput: false,
            Ct);
    }
}
