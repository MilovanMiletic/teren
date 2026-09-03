using Microsoft.EntityFrameworkCore;
using Teren.Api.Contracts;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Time;
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
        bool relayConfigured,
        CancellationToken ct)
    {
        // The supersede and the insert are two statements with nothing ordering them against a
        // concurrent call for the SAME worker: the other call's supersede can run while this
        // one's row does not exist yet, and then both inserts are live and the second is refused
        // by ux_activation_code_live. An admin double-tapping "issue a new code", or two quick
        // POSTs to /auth/activation-code, are enough to produce it — and before this loop the
        // answer was an unhandled DbUpdateException, i.e. a 500.
        //
        // One retry is the right bound, not a loop with a limit: the second pass supersedes the
        // row the winner just committed and is then alone. Losing twice in a row would mean a
        // third caller, which is not a race any more but a caller to slow down.
        var transaction = db.Database.CurrentTransaction;

        // Inside a caller's transaction (CreateWorkerAsync) a failed SaveChanges leaves Postgres
        // refusing every further statement, so retrying at all requires a savepoint — and the
        // caller's own earlier writes must survive it.
        if (transaction is not null)
        {
            await transaction.CreateSavepointAsync(RetrySavepoint, ct);
        }

        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return await IssueOnceAsync(
                    db, worker, actorUserId, auditAction, lifetime, relayConfigured, ct);
            }
            catch (DbUpdateException ex)
                when (attempt == 0 && PostgresErrors.IsUniqueViolation(ex, "ux_activation_code_live"))
            {
                foreach (var entry in db.ChangeTracker.Entries()
                    .Where(e => e.State == EntityState.Added)
                    .ToList())
                {
                    entry.State = EntityState.Detached;
                }

                if (transaction is not null)
                {
                    await transaction.RollbackToSavepointAsync(RetrySavepoint, ct);
                }
            }
        }
    }

    /// <summary>The savepoint name is a constant because a typo would only show up under
    /// contention, which is exactly when nobody is watching.</summary>
    private const string RetrySavepoint = "issue_activation_code";

    private static async Task<ActivationCodeResponse> IssueOnceAsync(
        TerenIdentityDbContext db,
        AppUser worker,
        Guid actorUserId,
        string auditAction,
        TimeSpan lifetime,
        bool relayConfigured,
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
        db.AdminAudits.Add(AdminAudit.For(
            actorUserId, auditAction, "app_user", worker.Id, worker.CompanyId, now));

        await db.SaveChangesAsync(ct);

        return Describe(row, worker.Email, relayConfigured);
    }

    /// <summary>The worker's live, unexpired code, or null. Read-only: looking at a code must
    /// never be what kills the code the man is about to type.</summary>
    public static async Task<ActivationCodeResponse?> LiveAsync(
        TerenIdentityDbContext db, AppUser worker, bool relayConfigured, CancellationToken ct)
    {
        var now = DateTime.UtcNow;

        var row = await db.ActivationCodes
            .AsNoTracking()
            .Where(c => c.UserId == worker.Id
                && c.ConsumedAt == null
                && c.SupersededAt == null
                && c.ExpiresAt > now)
            .FirstOrDefaultAsync(ct);

        return row is null ? null : Describe(row, worker.Email, relayConfigured);
    }

    /// <summary>
    /// <b>The code is always in the response body.</b> Email is one delivery channel, never
    /// <em>the</em> channel — a worker without an address and a host without a relay must both
    /// still be able to onboard, so the admin can read the code off his screen either way (§9).
    /// </summary>
    private static ActivationCodeResponse Describe(
        ActivationCode row, string? workerEmail, bool relayConfigured) =>
        new(
            row.CodeDisplay ?? string.Empty,
            UtcStamp.Of(row.CreatedAt),
            UtcStamp.Of(row.ExpiresAt),
            DeliveryOf(workerEmail, relayConfigured));

    /// <summary>
    /// What actually became of this code as far as email is concerned.
    /// <para>
    /// <b>It answered <c>not_configured</c> unconditionally until 2026-09-02, which became a lie
    /// the moment D6 shipped a relay</b> — the screen said "no mail is configured" on a host that
    /// had one. The truth on these two admin routes is narrower and more useful:
    /// <c>not_sent</c>. Nothing here mails a code even when it can, and that is the design rather
    /// than an omission — an admin reads the code to one man, in one message, on one screen
    /// (§2 decision 13), because a code plus a username is a working identity and a group chat
    /// full of both is how a foreman's evidence ends up signed with somebody else's name.
    /// </para>
    /// <para>
    /// <c>queued</c> belongs to the one path that does send: the worker's own
    /// <c>POST /auth/activation-code</c>, whose job mints and mails in one act — and which returns
    /// no body at all, because saying anything about the outcome would say whether that username
    /// exists.
    /// </para>
    /// </summary>
    private static string DeliveryOf(string? workerEmail, bool relayConfigured) =>
        workerEmail is null
            ? EmailDelivery.NoAddress
            : relayConfigured ? EmailDelivery.NotSent : EmailDelivery.NotConfigured;
}
