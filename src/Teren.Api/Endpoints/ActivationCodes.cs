using Microsoft.EntityFrameworkCore;
using Npgsql;
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
                return await IssueOnceAsync(db, worker, actorUserId, auditAction, lifetime, ct);
            }
            catch (DbUpdateException ex)
                when (attempt == 0 && IsUniqueViolation(ex, "ux_activation_code_live"))
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

    /// <summary>
    /// Spends the database round trips <see cref="IssueAsync"/> spends, and writes nothing.
    /// <para>
    /// <b>Why a deliberate waste of statements exists in this file.</b>
    /// <c>POST /auth/activation-code</c> answers 202 whether or not the username exists and
    /// whether or not that worker has an address on file — §10.3 requires both distinctions to
    /// stay invisible <em>at runtime</em>. A body that is byte-identical is only half of that: the
    /// eligible branch supersedes a row, opens a transaction and inserts the code and its audit
    /// row, and a stopwatch on an unauthenticated route reads that difference straight off. This
    /// is the same trade <see cref="PasswordHash.DummyVerify"/> makes on the login route — burn
    /// the same wall clock rather than return early and leak by how fast.
    /// </para>
    /// <para>
    /// It matches <b>round trips</b>, not rows, and that is the honest granularity: a statement
    /// against a database on the same host costs its round trip and its parse far more than it
    /// costs two small inserts. Matching row for row is impossible anyway — an
    /// <c>activation_code</c> row needs a real <c>user_id</c>, and the branch this covers is
    /// precisely the one with no user.
    /// </para>
    /// </summary>
    public static async Task BurnIssueCostAsync(TerenIdentityDbContext db, CancellationToken ct)
    {
        for (var i = 0; i < IssueStatementCost; i++)
        {
            await NoOpAsync(db, ct);
        }

        // And the transaction SaveChangesAsync opens around the insert, which is two more round
        // trips on its own.
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        await NoOpAsync(db, ct);
        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// How many statements <see cref="IssueOnceAsync"/> costs beyond the transaction below —
    /// the supersede, and what EF spends turning two tracked inserts into durable rows.
    /// <para>
    /// <b>Calibrated, not derived, and that is a real weakness of this mechanism</b>: EF decides
    /// how many commands a <c>SaveChangesAsync</c> becomes, and a change to the entities or to
    /// batching moves the number. It is safe to be a little wrong in either direction — the
    /// property is that neither branch stands out — and it does not go unnoticed if it drifts:
    /// <c>ActivationTimingTests.Asking_for_a_code_costs_the_same_whether_or_not_it_issues_one</c>
    /// prints both medians on every run and fails when they separate.
    /// </para>
    /// </summary>
    private const int IssueStatementCost = 6;

    /// <summary>
    /// One statement that matches nothing and costs what the real supersede costs.
    /// <para>
    /// <b>The two null predicates are not decoration — they are what makes this cost the same
    /// thing as the branch it is imitating.</b> <c>ux_activation_code_live</c> is a PARTIAL index
    /// (<c>WHERE consumed_at IS NULL AND superseded_at IS NULL</c>), and Postgres will only use a
    /// partial index for a query whose own predicate implies the index predicate. Filtering on
    /// <c>user_id</c> alone does not imply it, so this planned as a <b>sequential scan</b> while
    /// <see cref="IssueOnceAsync"/>'s supersede index-scanned. <c>activation_code</c> rows are
    /// never deleted, so that seq scan grows linearly with the table while the real branch stays
    /// O(1) — and after a few months of operation the <em>rejection</em> path of
    /// <c>POST /auth/activation-code</c> would be measurably slower than the issuing path, which
    /// is the §10.3 oracle again with its sign inverted. With them, both statements take the same
    /// plan. The rows matched are the same either way: none.
    /// </para>
    /// <para>
    /// <c>Guid.Empty</c> is not a user id anybody has — every one in the product is generated.
    /// </para>
    /// </summary>
    private static Task NoOpAsync(TerenIdentityDbContext db, CancellationToken ct) =>
        db.ActivationCodes
            .Where(c => c.UserId == Guid.Empty
                && c.ConsumedAt == null
                && c.SupersededAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(c => c.SupersededAt, c => c.SupersededAt), ct);

    private static bool IsUniqueViolation(DbUpdateException ex, string constraintName) =>
        ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } pg
        && string.Equals(pg.ConstraintName, constraintName, StringComparison.Ordinal);

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
