using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

/// <summary>
/// Minting a set-password link, in one place because <b>the supersede is a security invariant and
/// nothing in the database enforces it</b>.
///
/// <para>
/// Two callers need this — the <c>invite-admin</c> console command and
/// <c>POST /api/platform/users/{id}/invite</c> — and they must do exactly the same thing to the
/// database, so they do it here. That is the same reasoning <see cref="ActivationCodes"/> records
/// for the three routes that issue an activation code.
/// </para>
///
/// <para>
/// <b>Why the supersede cannot be left to the schema.</b> There is no
/// <c>ux_password_token_live</c>: two live tokens for one user are perfectly storable, and
/// <c>POST /auth/password</c> would honour both. So an admin who re-issues because "the first link
/// never arrived" would leave the first one valid for another 48 hours — in whatever inbox or chat
/// it did in fact arrive in. Retiring it is the whole job, and a second copy of this logic is a
/// second chance to get it wrong.
/// </para>
///
/// <para>
/// Expired-but-unconsumed rows are superseded too. They are already unusable (the set-password
/// path filters on <c>expires_at</c>), so that is bookkeeping rather than a withdrawal — it keeps
/// "live" meaning one thing when reading the table by hand.
/// </para>
/// </summary>
internal static class PasswordTokens
{
    /// <summary>What the caller needs to tell a human, and nothing it does not.</summary>
    internal readonly record struct Issued(
        string Token,
        PasswordTokenPurpose Purpose,
        DateTime ExpiresAt,
        int Superseded);

    /// <summary>
    /// Retire every live link this user has and mint one more.
    ///
    /// <para>
    /// <paramref name="actorUserId"/> is who is answerable. The console command passes the subject
    /// himself — a console invite has no other actor, and saying so is more honest than inventing
    /// one — while the platform route passes the signed-in super admin, which is the answer to
    /// "who let this person back in".
    /// </para>
    /// <para>
    /// <paramref name="source"/> lands in the audit detail (<c>console</c> / <c>platform</c>) so
    /// the trail can distinguish a link minted at a terminal from one minted through the product.
    /// It is a fixed vocabulary, never caller text: <c>admin_audit.detail</c> follows the same rule
    /// as the log stream, and free text is how personal data gets into it.
    /// </para>
    /// <para>
    /// <b>Does not call <c>SaveChanges</c> and does not open a transaction.</b> The caller owns
    /// both, because the console command wants one transaction around its whole run and a route
    /// wants one around the request. The plaintext is returned and never stored: only its SHA-256
    /// reaches the database.
    /// </para>
    /// </summary>
    public static async Task<Issued> IssueAsync(
        TerenIdentityDbContext db,
        AppUser user,
        Guid actorUserId,
        string source,
        TimeSpan lifetime,
        CancellationToken ct)
    {
        // Invite means "this account has never had a password"; reset means "it has one already".
        // Derived rather than requested: it is a fact about the row, and a parameter would only be
        // a way to record it wrongly.
        var purpose = user.PasswordHash is null
            ? PasswordTokenPurpose.Invite
            : PasswordTokenPurpose.Reset;

        var now = DateTime.UtcNow;
        var token = CredentialTokens.New(CredentialTokens.PasswordPrefix);
        var expiresAt = now.Add(lifetime);

        var superseded = await db.PasswordTokens
            .Where(t => t.UserId == user.Id && t.ConsumedAt == null && t.SupersededAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.SupersededAt, now), ct);

        db.PasswordTokens.Add(new PasswordToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Purpose = purpose,
            TokenHash = CredentialTokens.Hash(token),
            CreatedAt = now,
            ExpiresAt = expiresAt,
        });

        db.AdminAudits.Add(AdminAudit.For(
            actorUserId,
            AdminAuditActions.PasswordTokenIssued,
            "app_user",
            user.Id,
            user.CompanyId,
            now,
            $$"""
            {"source": "{{source}}", "purpose": "{{PasswordTokenPurposeNames.ToWire(purpose)}}", "superseded": {{superseded}}}
            """));

        return new Issued(token, purpose, expiresAt, superseded);
    }

    /// <summary>
    /// The link a human follows, or null when <c>Auth:AppUrl</c> is not configured.
    /// <para>
    /// Null is an ordinary outcome, not a failure: the token itself is perfectly usable and the
    /// caller can be told to build the URL. Standing policy is visible failure over silent
    /// invention, and guessing a host here would produce a link that goes nowhere.
    /// </para>
    /// </summary>
    public static string? LinkFor(string appUrl, string token) =>
        string.IsNullOrWhiteSpace(appUrl)
            ? null
            : $"{appUrl.TrimEnd('/')}/set-password?token={token}";
}
