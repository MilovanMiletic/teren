using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Maintenance;

/// <summary>
/// Mints a single-use set-password link for an admin who has none, and prints it once.
/// <code>
/// dotnet run --project src/Teren.Api -- invite-admin --email petar@example.com
/// </code>
/// <para>
/// <b>Why this exists: nothing else in the product ever creates a <c>password_token</c>.</b>
/// <c>POST /auth/password</c> only ever <em>consumes</em> one, so until this command an invited
/// company admin could never set a password → no company_admin session could exist →
/// <c>POST /api/workers/{id}/activation-code</c> was unreachable → <b>no activation code could be
/// issued through the product at all</b>. A super admin is correctly walled out of the
/// company-admin surface, so he was not a way round it either. The chain was completable only by
/// hand-writing a row in psql, which is not a thing a founder may depend on before
/// <c>environment.deviceToken</c> is emptied (D7/F9).
/// </para>
/// <para>
/// <b>It invites; it never creates.</b> The account must already exist, and the command will not
/// create one, will not change a role, and will not create a company. Three reasons, in order of
/// weight: the broken link in the chain was the mint and only the mint, so creating accounts here
/// would be scope with no payoff; creating a company admin means first choosing or creating a
/// <c>company</c> — name, time zone, report language, distribution list — which is D4's platform
/// surface (§8), and a second writer of those rows in a shell is exactly the thing that silently
/// drifts from the reviewed one; and a command that can only widen an existing decision (this
/// person should be able to sign in) has a blast radius a reader can check in one sitting, while
/// one that can conjure a privileged account does not. <b>Consequence, stated plainly: onboarding
/// a brand-new company still needs its <c>company</c> and <c>app_user</c> rows from D4 or from
/// psql. What no longer needs psql is the credential.</b>
/// </para>
/// <para>
/// <b>Both admin roles, deliberately.</b> <c>SetPasswordAsync</c> admits any non-worker with an
/// address, and a rule that lived only in this command would be a rule nobody could find. For
/// Teren's own staff <see cref="CreateSuperAdminCommand"/> is usually the better tool — it sets
/// the password there and then — but a link is what §9's no-relay escape hatch hands to somebody
/// who is not standing at the console.
/// </para>
/// <para>
/// <b>No password is read here and none is written.</b> That is the difference from
/// <see cref="CreateSuperAdminCommand"/> and it is why this command has no stdin at all: it
/// produces a link, the person at the other end chooses his own passphrase over
/// <c>POST /auth/password</c>, and the founder never learns it.
/// </para>
/// </summary>
public static class InviteAdminCommand
{
    /// <summary>The verb, typed in full — same taste as <c>create-super-admin</c>.</summary>
    public const string CommandName = "invite-admin";

    public static async Task<int> RunAsync(
        TerenIdentityDbContext db,
        IReadOnlyList<string> args,
        TextWriter output,
        TimeSpan lifetime,
        string appUrl,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(output);

        if (!EmailAddress.TryNormalise(ValueOf(args, "--email"), out var email))
        {
            return Refuse(output, $"--email is required and must be an email address.{Usage}");
        }

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email == email, ct);

        if (user is null)
        {
            // Says what it will not do, because the obvious next thought is "then create him".
            return Refuse(
                output,
                $"No account exists with the address {email}. This command invites an existing "
                + "admin; it does not create accounts, companies or roles.");
        }

        if (user.Role == AppUserRole.Worker)
        {
            // A worker with a password would be a second door into the diary, and the database
            // refuses to store one: ck_app_user_worker_has_no_password. POST /auth/password
            // refuses him too, so minting here would produce a link that is dead on arrival — and
            // a token that cannot be used is worse than a refusal, because it is discovered by the
            // person it was handed to. Failing here also keeps the CHECK from being how anyone
            // learns this rule.
            return Refuse(
                output,
                $"{email} is a worker. Workers never have a password "
                + "(ck_app_user_worker_has_no_password); they activate a phone with a username "
                + "and a one-time code. Issue one from the company-admin surface, or with "
                + "`seed` for the demo worker.");
        }

        if (user.DisabledAt is not null)
        {
            // Deliberately does NOT re-enable him. CreateSuperAdminCommand clears disabled_at
            // because that command IS the founder's way back into his own product; re-enabling a
            // customer's admin is an administrative act on somebody else's company, and it belongs
            // on the platform surface with an actor and an audit row that names him.
            return Refuse(
                output,
                $"{email} is disabled. POST /auth/password refuses a disabled account, so this "
                + "link would never work. Re-enable the account first.");
        }

        // A super admin has no company, by constraint (ck_app_user_company_scope).
        Company? company = null;

        if (user.CompanyId is Guid companyId)
        {
            company = await db.Companies.AsNoTracking()
                .FirstOrDefaultAsync(c => c.Id == companyId, ct);

            if (company is null)
            {
                return Refuse(output, $"{email} belongs to a company that no longer exists.");
            }

            if (company.SuspendedAt is not null)
            {
                // POST /auth/password would accept the token — it does not look at the company —
                // and then POST /auth/login would refuse the brand-new password with the same
                // deliberately uninformative 401 as a wrong one. The customer would have set a
                // password that does not work and nobody would be able to say why. Refuse where
                // the reason can still be stated.
                return Refuse(
                    output,
                    $"{company.Name} is suspended, so {email} could set a password and still not "
                    + "be able to sign in. Resume the company first.");
            }
        }

        // Invite means "this account has never had a password"; reset means "it has one already"
        // (PasswordTokenPurpose). Derived rather than flagged: it is a fact about the row, and a
        // flag would only be a way to record it wrongly.
        var purpose = user.PasswordHash is null
            ? PasswordTokenPurpose.Invite
            : PasswordTokenPurpose.Reset;

        var now = DateTime.UtcNow;
        var token = CredentialTokens.New(CredentialTokens.PasswordPrefix);
        var expiresAt = now.Add(lifetime);

        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        // THE SUPERSEDE, and unlike an activation code nothing in the database compels it: there
        // is no ux_password_token_live, so two live tokens for one user are perfectly storable and
        // POST /auth/password would honour both. Re-running this command must therefore retire the
        // link it is replacing itself, or a founder who re-issues because "the first one did not
        // arrive" leaves the first one valid for another 48 hours — in whatever inbox or chat it
        // did in fact arrive in.
        //
        // Expired-but-unconsumed rows are superseded too. They are already unusable
        // (SetPasswordAsync filters on expires_at), so this is bookkeeping rather than a
        // withdrawal, and it keeps "live" meaning one thing when reading the table by hand.
        var superseded = await db.PasswordTokens
            .Where(t => t.UserId == user.Id && t.ConsumedAt == null && t.SupersededAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.SupersededAt, now), ct);

        db.PasswordTokens.Add(new PasswordToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Purpose = purpose,
            // Only the SHA-256 is stored. The plaintext exists in this process and on the
            // founder's terminal and nowhere else, which is what makes the print below a one-off.
            TokenHash = CredentialTokens.Hash(token),
            CreatedAt = now,
            ExpiresAt = expiresAt,
        });

        db.AdminAudits.Add(new AdminAudit
        {
            Id = Guid.NewGuid(),
            // The subject himself: a console invite has no other actor, and saying so is more
            // honest than inventing one. Same choice CreateSuperAdminCommand makes.
            ActorUserId = user.Id,
            Action = AdminAuditActions.PasswordTokenIssued,
            SubjectType = "app_user",
            SubjectId = user.Id,
            CompanyId = user.CompanyId,
            Detail = $$"""
                {"source": "console", "purpose": "{{PasswordTokenPurposeNames.ToWire(purpose)}}", "superseded": {{superseded}}}
                """,
            CreatedAt = now,
        });

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);

        Print(output, email, user, company, purpose, token, expiresAt, superseded, appUrl);

        return 0;
    }

    private static void Print(
        TextWriter output,
        string email,
        AppUser user,
        Company? company,
        PasswordTokenPurpose purpose,
        string token,
        DateTime expiresAt,
        int superseded,
        string appUrl)
    {
        var role = AppUserRoleNames.ToWire(user.Role);
        var where = company is null ? "Teren staff" : company.Name;

        output.WriteLine();
        output.WriteLine($"Set-password link for {email} ({role}, {where}).");
        output.WriteLine(purpose == PasswordTokenPurpose.Invite
            ? "Purpose: invite — this account has never had a password."
            : "Purpose: reset — this account already has one, and it keeps working until the "
                + "link below is used.");
        output.WriteLine($"Expires: {expiresAt:yyyy-MM-dd HH:mm:ss} UTC.");

        if (superseded > 0)
        {
            output.WriteLine(
                $"Superseded {superseded} earlier link(s) for this account; they are dead now.");
        }

        output.WriteLine();
        output.WriteLine($"  token: {token}");
        output.WriteLine();
        output.WriteLine(
            "THIS IS PRINTED ONCE. Only its SHA-256 is stored, so it cannot be recovered — "
            + "re-run this command to mint another (which kills this one).");
        output.WriteLine();
        output.WriteLine("He sets his own password with:");
        output.WriteLine();
        output.WriteLine("""  curl -sS -X POST "$TEREN_API/auth/password" \""");
        output.WriteLine("""    -H 'content-type: application/json' \""");
        output.WriteLine(
            $$"""    -d '{"token":"{{token}}","password":"<at least 12 characters>"}'""");
        output.WriteLine();
        output.WriteLine(
            "  ($TEREN_API is http://localhost:5080 on a developer machine.)");

        if (appUrl.Length > 0)
        {
            // Auth:AppUrl is where the PWA lives. The /set-password screen is not built yet
            // (it arrives with the admin screens), so this is printed as the shape of the link
            // and not as a promise that it renders today.
            output.WriteLine();
            output.WriteLine(
                $"  Future link, once the set-password screen ships: "
                + $"{appUrl.TrimEnd('/')}/set-password?token={token}");
        }

        output.WriteLine();
        output.WriteLine($"Then he signs in at POST /auth/login with {email} and that password.");
        output.WriteLine();
    }

    private const string Usage = """


        dotnet run --project src/Teren.Api -- invite-admin --email petar@example.com

        The account must already exist. Nothing is created, no role is changed, and no password
        is read or written — this mints a single-use link and prints it once.

        """;

    /// <summary><c>--email x</c> or <c>--email=x</c>; both, because muscle memory differs.</summary>
    private static string? ValueOf(IReadOnlyList<string> args, string name)
    {
        for (var i = 0; i < args.Count; i++)
        {
            if (string.Equals(args[i], name, StringComparison.Ordinal) && i + 1 < args.Count)
            {
                return args[i + 1];
            }

            if (args[i].StartsWith(name + "=", StringComparison.Ordinal))
            {
                return args[i][(name.Length + 1)..];
            }
        }

        return null;
    }

    private static int Refuse(TextWriter output, string message)
    {
        output.WriteLine();
        output.WriteLine("REFUSED: " + message);
        output.WriteLine();

        // 2, matching reset-demo and create-super-admin: "you asked for something and did not
        // get it".
        return 2;
    }
}
