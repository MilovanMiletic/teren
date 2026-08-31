using Microsoft.EntityFrameworkCore;
using Teren.Api.Contracts;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

/// <summary>
/// Issuing and reading a worker's one live activation code. Three routes need this — the admin's
/// create-worker, his re-issue button, and the worker's own "send me a code" — and all three must
/// do exactly the same thing to the database, so they do it here.
/// </summary>
internal static class ActivationCodes
{
    /// <summary>
    /// Supersedes whatever live code the worker has and issues a fresh one, in the caller's
    /// transaction if there is one.
    /// <para>
    /// <b>The supersede is not tidiness — it is what <c>ux_activation_code_live</c> requires.</b>
    /// That unique index guarantees at most one typeable code per worker; inserting a second
    /// without retiring the first is a constraint violation, which is the design working. And the
    /// old row's <c>code_display</c> has to be nulled in the same statement, because
    /// <c>ck_activation_code_display_cleared</c> refuses to let a dead code keep holding
    /// plaintext.
    /// </para>
    /// <para>
    /// <b>Expiry is not in the index predicate and cannot be</b> (a partial predicate must be
    /// immutable and <c>now()</c> is not), so an <em>expired but unconsumed</em> row is still
    /// "live" as far as the database is concerned. It is superseded here like any other, which is
    /// also where its plaintext finally gets cleared.
    /// </para>
    /// </summary>
    public static async Task<ActivationCodeResponse> IssueAsync(
        TerenIdentityDbContext db,
        AppUser worker,
        Guid actorUserId,
        string auditAction,
        TimeSpan lifetime,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;

        await db.ActivationCodes
            .Where(c => c.UserId == worker.Id && c.ConsumedAt == null && c.SupersededAt == null)
            .ExecuteUpdateAsync(
                u => u
                    .SetProperty(c => c.SupersededAt, now)
                    .SetProperty(c => c.CodeDisplay, (string?)null),
                ct);

        // Canonical form is what gets hashed; the dashed form is what a human reads. Folding the
        // canonical form is a no-op — the Crockford alphabet contains no I, L, O or U — so a code
        // typed back in hashes to exactly this value.
        var code = ActivationCodeFormat.Generate();
        var display = ActivationCodeFormat.Format(code);

        var row = new ActivationCode
        {
            Id = Guid.NewGuid(),
            CompanyId = worker.CompanyId!.Value,
            UserId = worker.Id,
            CreatedByUserId = actorUserId,
            CodeHash = CredentialTokens.Hash(code),
            CodeDisplay = display,
            CreatedAt = now,
            ExpiresAt = now.Add(lifetime),
        };

        db.ActivationCodes.Add(row);
        db.AdminAudits.Add(new AdminAudit
        {
            Id = Guid.NewGuid(),
            ActorUserId = actorUserId,
            Action = auditAction,
            SubjectType = "app_user",
            SubjectId = worker.Id,
            CompanyId = worker.CompanyId,
            CreatedAt = now,
        });

        await db.SaveChangesAsync(ct);

        return Describe(row, worker.Email);
    }

    /// <summary>The worker's live, unexpired code, or null. Read-only: looking at a code must
    /// never be what kills the code the man is about to type.</summary>
    public static async Task<ActivationCodeResponse?> LiveAsync(
        TerenIdentityDbContext db, AppUser worker, CancellationToken ct)
    {
        var now = DateTime.UtcNow;

        var row = await db.ActivationCodes
            .AsNoTracking()
            .Where(c => c.UserId == worker.Id
                && c.ConsumedAt == null
                && c.SupersededAt == null
                && c.ExpiresAt > now)
            .FirstOrDefaultAsync(ct);

        return row is null ? null : Describe(row, worker.Email);
    }

    /// <summary>
    /// <b>The code is always in the response body.</b> Email is one delivery channel, never
    /// <em>the</em> channel — a worker without an address and a host without a relay must both
    /// still be able to onboard, so the admin can read the code off his screen either way (§9).
    /// </summary>
    private static ActivationCodeResponse Describe(ActivationCode row, string? workerEmail) =>
        new(
            row.CodeDisplay ?? string.Empty,
            new DateTimeOffset(DateTime.SpecifyKind(row.CreatedAt, DateTimeKind.Utc)),
            new DateTimeOffset(DateTime.SpecifyKind(row.ExpiresAt, DateTimeKind.Utc)),
            // D6 wires IMailSender and this becomes "queued" for a worker who has an address.
            // Until then no host in existence has a relay configured, and saying so plainly is
            // the standing policy: visible failure, never a silent one.
            workerEmail is null ? EmailDelivery.NoAddress : EmailDelivery.NotConfigured);
}
