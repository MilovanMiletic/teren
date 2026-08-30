namespace Teren.Infrastructure.Seeding;

/// <summary>
/// The pending background-job state a reset has to deal with, behind a seam so the reset itself
/// stays testable without a Hangfire storage.
/// <para>
/// "Pending" means enqueued, fetched, scheduled or processing — work that has not run yet and
/// will run against a database that no longer contains the entry it names. Recurring jobs are
/// deliberately out of scope: the sweeper is infrastructure, not demo data, and deleting it would
/// silently stop the safety net under the whole pipeline until the next start-up re-registered
/// it. Job *history* (succeeded, failed) is also left alone — it is the record of what happened,
/// it executes nothing, and destroying it would remove the evidence of a failure the founder may
/// be in the middle of diagnosing.
/// </para>
/// <para>
/// <b>Why a blanket purge of pending work is safe, rather than one filtered to the demo
/// company's entry ids.</b> Every job this system enqueues is enqueued from exactly two places —
/// <c>/complete</c> (an entry in <c>received</c>) and <c>/confirm</c> (an entry in
/// <c>confirmed</c> with no failure reason) — and <see cref="Processing.PipelineSweeper"/> picks
/// up both of those states on its own within the minute. So the queue holds nothing whose loss
/// the sweeper does not repair, which means deleting all of it cannot lose work; it can only
/// delay it. Filtering by job arguments instead would buy nothing and would have to guess about
/// jobs whose payload no longer deserialises — the ones most likely to be stale.
/// </para>
/// </summary>
public interface IDemoJobPurge
{
    /// <summary>Why this purge can do nothing, or null when it can. Reported, never thrown:
    /// a stack running without a job server is a normal configuration, not a fault.</summary>
    string? Unavailable { get; }

    /// <summary>Ids of every job that has not run yet.</summary>
    Task<IReadOnlyList<string>> ListPendingAsync(CancellationToken ct = default);

    /// <summary>Deletes exactly these jobs. Returns how many the storage confirmed.</summary>
    Task<int> DeleteAsync(IReadOnlyList<string> jobIds, CancellationToken ct = default);
}
