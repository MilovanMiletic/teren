using System.Text;
using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Maintenance;

/// <summary>
/// Bootstraps the first Teren staff account, because there is nobody to invite him.
/// <code>
/// dotnet run --project src/Teren.Api -- create-super-admin --email you@teren.rs --name "Your Name"
/// </code>
/// <para>
/// <b>The password is read from stdin and never from argv, and that is the whole reason this is a
/// command rather than a flag.</b> An argument lands in shell history, in <c>ps</c> output for
/// every user on the box, and in the process listing of any monitoring agent that happens to be
/// running. A super admin password is the credential that can enumerate every customer (§13.2), so
/// it does not get to be a string in <c>~/.bash_history</c>.
/// </para>
/// <para>
/// Interactively it echoes nothing and asks twice. Piped — <c>printf '%s\n' "$PW" | dotnet run
/// ... </c> — it reads one line, which is how a deploy script does it without a TTY.
/// </para>
/// </summary>
public static class CreateSuperAdminCommand
{
    /// <summary>The verb, typed in full. No alias: this creates the most privileged account in
    /// the product.</summary>
    public const string CommandName = "create-super-admin";

    /// <summary>Sets a new password on an existing super admin. Named for its effect, in the
    /// taste <c>--yes-delete-demo-data</c> already set.</summary>
    public const string ResetPasswordFlag = "--reset-password";

    public static async Task<int> RunAsync(
        TerenIdentityDbContext db,
        IReadOnlyList<string> args,
        TextReader input,
        TextWriter output,
        bool maskInput,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(args);

        if (!EmailAddress.TryNormalise(ValueOf(args, "--email"), out var email))
        {
            return Refuse(output, $"--email is required and must be an email address. Usage:{Usage}");
        }

        var displayName = (ValueOf(args, "--name") ?? string.Empty).Trim();
        if (displayName.Length == 0)
        {
            return Refuse(output, $"--name is required. Usage:{Usage}");
        }

        var resetPassword = args.Contains(ResetPasswordFlag, StringComparer.Ordinal);

        var existing = await db.Users.FirstOrDefaultAsync(u => u.Email == email, ct);

        if (existing is not null && existing.Role != AppUserRole.SuperAdmin)
        {
            // Promoting a customer's admin to Teren staff would move him outside every tenant
            // filter in the product (ck_app_user_company_scope: a super admin has no company), and
            // it would do it from a shell with no audit trail worth the name. Refused outright.
            return Refuse(
                output,
                $"{email} already exists as {AppUserRoleNames.ToWire(existing.Role)}. This "
                + "command will not change an existing account's role.");
        }

        if (existing is not null && !resetPassword)
        {
            return Refuse(
                output,
                $"{email} is already a super admin. To give it a new password, run the same "
                + $"command with {ResetPasswordFlag}.");
        }

        var password = ReadPassword(input, output, maskInput, confirm: maskInput);
        if (password is null)
        {
            return Refuse(output, "No password was read from stdin; nothing was written.");
        }

        if (!PasswordPolicy.IsAcceptable(password))
        {
            return Refuse(output, PasswordPolicy.Requirement);
        }

        var now = DateTime.UtcNow;
        var hashed = PasswordHash.Hash(password);
        var userId = existing?.Id ?? Guid.NewGuid();

        if (existing is null)
        {
            db.Users.Add(new AppUser
            {
                Id = userId,
                // NULL, and the database insists: ck_app_user_company_scope asserts
                // (role = 'super_admin') = (company_id IS NULL), so a super admin inside a tenant
                // is not a state this or any other code path can produce.
                CompanyId = null,
                Role = AppUserRole.SuperAdmin,
                Username = null,
                DisplayName = displayName,
                Email = email,
                PasswordHash = hashed,
                Language = "sr",
                CreatedAt = now,
            });
        }
        else
        {
            existing.PasswordHash = hashed;
            existing.DisplayName = displayName;
            // The other way this command unsticks a founder locked out of his own product.
            existing.DisabledAt = null;

            // A new password ends every session opened with the old one — same rule as
            // /auth/password, and for the same reason: a reset exists for the case where somebody
            // else may hold a credential.
            await db.AdminSessions
                .Where(s => s.UserId == userId && s.RevokedAt == null)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.RevokedAt, now), ct);
        }

        db.AdminAudits.Add(new AdminAudit
        {
            Id = Guid.NewGuid(),
            // The account itself: a console bootstrap has no other actor, and saying so is more
            // honest than inventing one.
            ActorUserId = userId,
            Action = existing is null
                ? AdminAuditActions.SuperAdminCreated
                : AdminAuditActions.PasswordSet,
            SubjectType = "app_user",
            SubjectId = userId,
            CompanyId = null,
            Detail = """{"source": "console"}""",
            CreatedAt = now,
        });

        await db.SaveChangesAsync(ct);

        output.WriteLine();
        output.WriteLine(existing is null
            ? $"Created super admin {email} ({userId:D})."
            : $"Reset the password for super admin {email} ({userId:D}); existing sessions revoked.");
        output.WriteLine("Sign in at POST /auth/login with this email and the password just set.");
        output.WriteLine();

        return 0;
    }

    private const string Usage = """


        dotnet run --project src/Teren.Api -- create-super-admin --email you@teren.rs --name "Your Name"

        The password is read from stdin, never from the command line.

        """;

    /// <summary>
    /// <c>--email you@teren.rs</c> or <c>--email=you@teren.rs</c>; both, because muscle memory
    /// differs and a typo here costs a whole run of a command that reads a password.
    /// </summary>
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

    private static string? ReadPassword(
        TextReader input, TextWriter output, bool maskInput, bool confirm)
    {
        output.Write("Password (not echoed): ");
        var password = maskInput ? ReadMasked(output) : input.ReadLine();
        output.WriteLine();

        if (string.IsNullOrEmpty(password))
        {
            return null;
        }

        if (!confirm)
        {
            return password;
        }

        output.Write("Repeat password: ");
        var again = ReadMasked(output);
        output.WriteLine();

        if (!string.Equals(password, again, StringComparison.Ordinal))
        {
            output.WriteLine("The two passwords did not match.");
            return null;
        }

        return password;
    }

    /// <summary>
    /// Reads a line from the console with nothing echoed — not even asterisks, which leak the
    /// length to anyone standing behind the founder. Backspace works, because a password you
    /// cannot correct is a password you type wrong.
    /// </summary>
    private static string ReadMasked(TextWriter output)
    {
        var typed = new StringBuilder();

        while (true)
        {
            var key = Console.ReadKey(intercept: true);

            if (key.Key == ConsoleKey.Enter)
            {
                return typed.ToString();
            }

            if (key.Key == ConsoleKey.Backspace)
            {
                if (typed.Length > 0)
                {
                    typed.Length--;
                }

                continue;
            }

            if (!char.IsControl(key.KeyChar))
            {
                typed.Append(key.KeyChar);
            }
        }
    }

    private static int Refuse(TextWriter output, string message)
    {
        output.WriteLine();
        output.WriteLine("REFUSED: " + message);
        output.WriteLine();

        // 2, matching reset-demo: "you asked for something and did not get it".
        return 2;
    }
}
