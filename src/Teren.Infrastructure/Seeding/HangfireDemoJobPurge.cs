using Hangfire;
using Hangfire.Storage;
using Microsoft.Extensions.Logging;

namespace Teren.Infrastructure.Seeding;

/// <summary>
/// <see cref="IDemoJobPurge"/> over the real Hangfire storage.
/// <para>
/// It deletes through <see cref="IBackgroundJobClient"/> rather than by writing SQL into the
/// <c>hangfire</c> schema, so a job a worker is holding is moved to the Deleted state by the
/// same state machine the worker consults — a job deleted this way does not run, and one that is
/// already mid-flight aborts at its next state transition instead of being yanked out from under
/// a running thread.
/// </para>
/// </summary>
public sealed class HangfireDemoJobPurge(
    JobStorage storage, IBackgroundJobClient jobs, ILogger<HangfireDemoJobPurge> logger)
    : IDemoJobPurge
{
    /// <summary>One page big enough that a demo host's queue is read in a single pass.</summary>
    private const int PageSize = 1000;

    /// <inheritdoc />
    public string? Unavailable => null;

    /// <inheritdoc />
    public Task<IReadOnlyList<string>> ListPendingAsync(CancellationToken ct = default)
    {
        var monitor = storage.GetMonitoringApi();

        // A set, because a job can appear in two of these listings at once — the window between
        // a worker fetching a job and reporting it as processing is exactly when a reset is most
        // likely to be run, and deleting the same id twice would over-report what was removed.
        var pending = new HashSet<string>(StringComparer.Ordinal);

        foreach (var queue in monitor.Queues())
        {
            Collect(pending, monitor.EnqueuedJobs(queue.Name, 0, PageSize).Select(job => job.Key));
            Collect(pending, monitor.FetchedJobs(queue.Name, 0, PageSize).Select(job => job.Key));
        }

        Collect(pending, monitor.ScheduledJobs(0, PageSize).Select(job => job.Key));
        Collect(pending, monitor.ProcessingJobs(0, PageSize).Select(job => job.Key));

        return Task.FromResult<IReadOnlyList<string>>([.. pending]);
    }

    /// <inheritdoc />
    public Task<int> DeleteAsync(IReadOnlyList<string> jobIds, CancellationToken ct = default)
    {
        var deleted = jobIds.Count(jobs.Delete);

        logger.LogInformation(
            "Removed {Deleted} of {Requested} pending background job(s).", deleted, jobIds.Count);

        return Task.FromResult(deleted);
    }

    private static void Collect(HashSet<string> into, IEnumerable<string> ids)
    {
        foreach (var id in ids)
        {
            into.Add(id);
        }
    }
}

/// <summary>
/// What stands in when the process runs with <c>Hangfire:Enabled=false</c>. There is no job
/// server and therefore no queue, which is a normal configuration and not a failure — it says so
/// and the reset reports it rather than pretending it purged something.
/// </summary>
public sealed class NoDemoJobPurge : IDemoJobPurge
{
    public string? Unavailable =>
        "Hangfire is switched off in this configuration (Hangfire:Enabled=false), so there is no "
        + "queue to purge. Anything already queued by another process is untouched.";

    public Task<IReadOnlyList<string>> ListPendingAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<string>>([]);

    public Task<int> DeleteAsync(IReadOnlyList<string> jobIds, CancellationToken ct = default) =>
        Task.FromResult(0);
}
