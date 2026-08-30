using Microsoft.EntityFrameworkCore;

namespace Teren.Infrastructure.Seeding;

/// <summary>Row counts, one per table the demo company owns.</summary>
public sealed record DemoRowCounts(int Companies, int Projects, int Entries, int Media, int Reports)
{
    public static readonly DemoRowCounts Empty = new(0, 0, 0, 0, 0);

    public int Total => Companies + Projects + Entries + Media + Reports;
}

/// <summary>What a reset would destroy, without destroying it.</summary>
public sealed record DemoResetPlan(
    DemoRowCounts Present,
    int ReportedEntries,
    int Objects,
    string? ObjectsUnavailable,
    int PendingJobs,
    string? JobsUnavailable);

/// <summary>What a reset actually did. Every number here is reported to the terminal.</summary>
public sealed record DemoResetResult(
    DemoRowCounts Removed,
    int ReportedEntriesRemoved,
    int Reseeded,
    DemoRowCounts FinalState,
    int ObjectsRemoved,
    string? ObjectsUnavailable,
    int JobsRemoved,
    string? JobsUnavailable,
    bool GuardArmed);

/// <summary>
/// Undoing a demo: everything belonging to the demo company goes, and the seed goes back.
/// <para>
/// <see cref="DemoSeeder"/> is idempotent per row, so <c>seed</c> can add what is missing but can
/// never remove what a demo added. Every demo the distributor gives leaves a real entry behind —
/// "test test", a photograph of a desk — which is confirmed, reported and then <b>sealed
/// permanently</b> by <c>trg_entry_guard_delete</c>. Ten demos later the archive is junk with the
/// three good Serbian entries buried in it, at exactly the moment somebody is deciding whether to
/// buy. This is the way back to a known-good state.
/// </para>
///
/// <para><b>The immutability guard.</b> A reported entry cannot be deleted; that is a product
/// invariant (PROJECT.md principle 2), not an inconvenience, and this command is the only thing
/// in the system allowed to step around it. It does so by disabling exactly one trigger —
/// <c>trg_entry_guard_delete</c> — inside the transaction that does the deleting, and re-enabling
/// it before the commit. Two things make that safe:</para>
/// <list type="bullet">
/// <item><c>ALTER TABLE ... DISABLE TRIGGER</c> is transactional DDL in Postgres, so a failure
/// anywhere between the disable and the commit rolls the trigger back into place <em>together
/// with</em> the rows. There is no ordering of failures that can leave a database with its
/// evidence guard off.</item>
/// <item>Only the <em>delete</em> guard is touched. <c>trg_entry_guard_update</c> stays armed
/// throughout, so even during the window nothing can quietly rewrite a reported entry or
/// overwrite a transcript. The reset never updates an entry; it deletes and re-seeds.</item>
/// </list>
/// <para>The re-enable is also verified against <c>pg_trigger</c> before the commit, so the
/// command reports the guard's real state rather than the fact that it issued a statement.</para>
///
/// <para><b>Order.</b> <c>fk_media_entry</c>, <c>fk_report_entry</c> and <c>fk_entry_project</c>
/// are all RESTRICT, not CASCADE — deliberately, because nothing in the product should be able to
/// erase evidence by deleting something next to it. So: reports, then media, then entries, then
/// projects, then the company. Entries themselves are peeled leaf-first, because
/// <c>fk_entry_supersedes_entry</c> is RESTRICT too and a correction chain (ROADMAP C4) would
/// otherwise fail depending on the order Postgres happened to delete rows in.</para>
///
/// <para><b>Scope.</b> Every statement is <c>WHERE company_id = </c><see cref="DemoSeeder.CompanyId"/>.
/// That is checked rather than trusted: the rows belonging to every <em>other</em> company are
/// counted before and after the deletes, inside the same transaction, and a single row of
/// difference aborts and rolls the whole thing back.</para>
///
/// <para><b>What happens outside the transaction, and why in this order.</b> Object storage and
/// the job queue are not transactional, so both are dealt with <em>after</em> the commit. If
/// objects were deleted first and the transaction then rolled back, bytes would be gone for rows
/// that still exist — evidence destroyed for an entry that still claims to have it. Committing
/// first means the worst case is the harmless one: objects left over, which the next reset sweeps
/// up, which is also what makes the whole command idempotent.</para>
/// </summary>
public static class DemoReset
{
    /// <summary>The only company this command will ever touch.</summary>
    public static Guid CompanyId => DemoSeeder.CompanyId;

    /// <summary>Object keys belonging to the demo company (<see cref="Core.Storage.ObjectKeys"/>).</summary>
    public static string ObjectPrefix => $"company/{DemoSeeder.CompanyId:D}/";

    /// <summary>The trigger this command is allowed to stand down, and only inside a transaction.</summary>
    private const string DeleteGuardTrigger = "trg_entry_guard_delete";

    /// <summary>
    /// A ceiling on waiting for the ACCESS EXCLUSIVE lock that <c>DISABLE TRIGGER</c> takes on
    /// <c>entry</c>. The founder's API is usually running against the same database; without this
    /// the command would hang silently behind a live request instead of saying what is in its way.
    /// </summary>
    private const string LockTimeout = "10s";

    /// <summary>Reports what a reset would destroy. Reads only.</summary>
    public static async Task<DemoResetPlan> InspectAsync(
        DbContext db,
        IDemoObjectPurge? objects = null,
        IDemoJobPurge? jobs = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);

        var present = await CountDemoRowsAsync(db, ct);
        var reported = await ScalarAsync(
            db, "SELECT count(*)::int AS \"Value\" FROM entry WHERE company_id = {0} "
                + "AND reported_at IS NOT NULL", ct);

        var (objectCount, objectsUnavailable) = await TryAsync(
            async () => (await ListObjectsAsync(objects, ct)).Count, objects is null
                ? "no object-storage purge was wired into this process"
                : null);

        var (jobCount, jobsUnavailable) = await TryAsync(
            async () => jobs is null ? 0 : (await jobs.ListPendingAsync(ct)).Count,
            jobs?.Unavailable ?? (jobs is null ? "no job purge was wired into this process" : null));

        return new DemoResetPlan(
            present, reported, objectCount, objectsUnavailable, jobCount, jobsUnavailable);
    }

    /// <summary>
    /// Deletes everything the demo company owns and re-seeds it. Idempotent: running it twice
    /// leaves the same state as running it once, and running it against a database that was never
    /// seeded simply seeds it.
    /// </summary>
    /// <param name="db">A context on the demo database. Query filters are irrelevant here — every
    /// statement is raw SQL scoped by <c>company_id</c>, which is also what keeps this out of the
    /// <c>IgnoreQueryFilters</c> rule the rest of the codebase lives under.</param>
    /// <param name="objects">Purges the bucket. Null means "not wired", which is reported rather
    /// than treated as zero objects.</param>
    /// <param name="jobs">Purges pending background jobs. Null means "not wired".</param>
    public static async Task<DemoResetResult> ResetAsync(
        DbContext db,
        IDemoObjectPurge? objects = null,
        IDemoJobPurge? jobs = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);

        // Nothing tracked from before may take part in the deletes or the re-seed; the seeder
        // decides what to insert by querying, and a stale tracked entity would answer for the
        // database.
        db.ChangeTracker.Clear();

        var reportedRemoved = await ScalarAsync(
            db, "SELECT count(*)::int AS \"Value\" FROM entry WHERE company_id = {0} "
                + "AND reported_at IS NOT NULL", ct);

        var strategy = db.Database.CreateExecutionStrategy();

        var (removed, reseeded) = await strategy.ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(ct);

            // SET LOCAL: scoped to this transaction, restored on commit or rollback.
            await db.Database.ExecuteSqlRawAsync($"SET LOCAL lock_timeout = '{LockTimeout}'", ct);

            var foreignBefore = await CountForeignRowsAsync(db, ct);

            // The one place in the product that stands the evidence guard down. Transactional
            // DDL, so a rollback re-arms it whatever goes wrong below.
            await db.Database.ExecuteSqlRawAsync(
                $"ALTER TABLE entry DISABLE TRIGGER {DeleteGuardTrigger}", ct);

            var reports = await ExecuteScopedAsync(
                db, "DELETE FROM report WHERE company_id = {0}", ct);
            var media = await ExecuteScopedAsync(
                db, "DELETE FROM media WHERE company_id = {0}", ct);
            var entries = await DeleteEntriesLeafFirstAsync(db, ct);
            var projects = await ExecuteScopedAsync(
                db, "DELETE FROM project WHERE company_id = {0}", ct);
            var companies = await ExecuteScopedAsync(
                db, "DELETE FROM company WHERE id = {0}", ct);

            await db.Database.ExecuteSqlRawAsync(
                $"ALTER TABLE entry ENABLE TRIGGER {DeleteGuardTrigger}", ct);

            var armed = await IsDeleteGuardArmedAsync(db, ct);

            if (!armed)
            {
                // Unreachable short of Postgres lying, but the whole point of this command is
                // that the guard comes back, so it is asserted rather than assumed.
                throw new InvalidOperationException(
                    $"{DeleteGuardTrigger} did not come back on after the reset; rolling back so "
                    + "the database keeps both its guard and its data.");
            }

            var foreignAfter = await CountForeignRowsAsync(db, ct);

            if (foreignBefore != foreignAfter)
            {
                throw new InvalidOperationException(
                    $"the reset would have changed rows outside the demo company "
                    + $"{DemoSeeder.CompanyId:D} (before: {foreignBefore}, after: {foreignAfter}); "
                    + "rolling back. This is a bug in the reset, not a state to work around.");
            }

            // Inside the same transaction: a failure here restores the demo that was there
            // before, rather than leaving the founder with no demo at all.
            db.ChangeTracker.Clear();
            var inserted = await DemoSeeder.SeedAsync(db, ct);

            await transaction.CommitAsync(ct);

            return (new DemoRowCounts(companies, projects, entries, media, reports), inserted);
        });

        // Only now that the rows are gone for good. See the type comment: committing first is
        // what makes a crash leave harmless leftovers instead of orphaned evidence.
        var (objectsRemoved, objectsUnavailable) = await TryAsync(
            async () =>
            {
                var keys = await ListObjectsAsync(objects, ct);
                return keys.Count == 0 ? 0 : await objects!.DeleteAsync(keys, ct);
            },
            objects is null ? "no object-storage purge was wired into this process" : null);

        var (jobsRemoved, jobsUnavailable) = await TryAsync(
            async () =>
            {
                if (jobs is null || jobs.Unavailable is not null)
                {
                    return 0;
                }

                var pending = await jobs.ListPendingAsync(ct);
                return pending.Count == 0 ? 0 : await jobs.DeleteAsync(pending, ct);
            },
            jobs?.Unavailable ?? (jobs is null ? "no job purge was wired into this process" : null));

        var finalState = await CountDemoRowsAsync(db, ct);

        return new DemoResetResult(
            removed,
            reportedRemoved,
            reseeded,
            finalState,
            objectsRemoved,
            objectsUnavailable,
            jobsRemoved,
            jobsUnavailable,
            await IsDeleteGuardArmedAsync(db, ct));
    }

    /// <summary>
    /// Deletes the demo company's entries leaf-first, because <c>fk_entry_supersedes_entry</c> is
    /// RESTRICT: a correction is checked the moment its parent row is deleted, so one bulk
    /// statement can fail purely on the order Postgres chose. Each pass removes the entries
    /// nothing left in the table supersedes.
    /// </summary>
    private static async Task<int> DeleteEntriesLeafFirstAsync(DbContext db, CancellationToken ct)
    {
        var total = 0;

        while (true)
        {
            var removed = await ExecuteScopedAsync(
                db,
                """
                DELETE FROM entry
                WHERE company_id = {0}
                  AND NOT EXISTS (
                        SELECT 1 FROM entry AS correction
                        WHERE correction.supersedes_entry_id = entry.id)
                """,
                ct);

            total += removed;

            if (removed > 0)
            {
                continue;
            }

            var left = await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM entry WHERE company_id = {0}", ct);

            if (left == 0)
            {
                return total;
            }

            // A demo entry that some *other* company's entry supersedes. Impossible today, and
            // deleting across the tenant boundary to fix it would be worse than stopping.
            throw new InvalidOperationException(
                $"{left} demo entry(ies) cannot be deleted: something outside the demo company "
                + "supersedes them. Nothing was reset.");
        }
    }

    private static async Task<DemoRowCounts> CountDemoRowsAsync(DbContext db, CancellationToken ct) =>
        new(
            Companies: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM company WHERE id = {0}", ct),
            Projects: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM project WHERE company_id = {0}", ct),
            Entries: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM entry WHERE company_id = {0}", ct),
            Media: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM media WHERE company_id = {0}", ct),
            Reports: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM report WHERE company_id = {0}", ct));

    /// <summary>Everything the reset must not touch, as one comparable fingerprint.</summary>
    private static async Task<DemoRowCounts> CountForeignRowsAsync(
        DbContext db, CancellationToken ct) =>
        new(
            Companies: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM company WHERE id <> {0}", ct),
            Projects: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM project WHERE company_id <> {0}", ct),
            Entries: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM entry WHERE company_id <> {0}", ct),
            Media: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM media WHERE company_id <> {0}", ct),
            Reports: await ScalarAsync(
                db, "SELECT count(*)::int AS \"Value\" FROM report WHERE company_id <> {0}", ct));

    /// <summary>
    /// Asks Postgres, not the command's own memory, whether the delete guard is armed.
    /// <c>tgenabled = 'O'</c> is "fires on origin", the normal state.
    /// </summary>
    private static async Task<bool> IsDeleteGuardArmedAsync(DbContext db, CancellationToken ct)
    {
        var armed = await db.Database
            .SqlQueryRaw<bool>(
                $"""
                 SELECT (tgenabled = 'O') AS "Value"
                 FROM pg_trigger
                 WHERE tgrelid = 'entry'::regclass AND tgname = '{DeleteGuardTrigger}'
                 """)
            .ToListAsync(ct);

        // No row at all means the trigger is not merely disabled but gone — never "armed".
        return armed is [true];
    }

    private static Task<int> ExecuteScopedAsync(DbContext db, string sql, CancellationToken ct) =>
        db.Database.ExecuteSqlRawAsync(sql, [DemoSeeder.CompanyId], ct);

    private static async Task<int> ScalarAsync(DbContext db, string sql, CancellationToken ct) =>
        (await db.Database.SqlQueryRaw<int>(sql, DemoSeeder.CompanyId).ToListAsync(ct)).Single();

    private static async Task<IReadOnlyList<string>> ListObjectsAsync(
        IDemoObjectPurge? objects, CancellationToken ct) =>
        objects is null ? [] : await objects.ListAsync(ObjectPrefix, ct);

    /// <summary>
    /// Runs one of the two non-transactional purges. A bucket or a job storage that cannot be
    /// reached is reported, never thrown: by the time these run the database work is committed,
    /// and turning "the leftovers could not be swept" into a failed command would tell the
    /// founder his demo is broken when it is fine.
    /// </summary>
    private static async Task<(int Count, string? Unavailable)> TryAsync(
        Func<Task<int>> work, string? unavailable)
    {
        if (unavailable is not null)
        {
            return (0, unavailable);
        }

        try
        {
            return (await work(), null);
        }
        catch (Exception ex)
        {
            return (0, ex.Message);
        }
    }
}
