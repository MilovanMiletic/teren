using Hangfire;
using Microsoft.Extensions.Logging;

namespace Teren.Api.Jobs;

/// <summary>
/// How much work is waiting, as the health page needs to see it.
/// <para>
/// <see cref="Available"/> false means the number is unknown, not zero, and the two must never be
/// conflated on this screen: an empty queue is the healthiest state there is, and "nobody is
/// running a job server" is one of the worst. <see cref="Detail"/> is a fixed token for the screen
/// to translate, never a provider's own sentence.
/// </para>
/// </summary>
/// <param name="Enqueued">Waiting to be picked up, plus anything fetched and not yet finished.</param>
/// <param name="Servers">Job servers with a live registration — zero means nothing is working.</param>
public sealed record JobQueueDepth(
    bool Available,
    string? Detail,
    int Enqueued,
    int Scheduled,
    int Processing,
    int Failed,
    int Servers)
{
    /// <summary>The tokens <see cref="Detail"/> can hold. A closed set, because this string is
    /// rendered on a screen and translated by key.</summary>
    public const string NotConfigured = "not_configured";

    /// <summary>The job storage answered with an error. What it said is logged, never returned —
    /// a storage exception message is exactly the kind of free text that has no business on a
    /// platform response (ARCHITECTURE §12).</summary>
    public const string Unreadable = "unreadable";

    public static JobQueueDepth Unknown(string detail) => new(false, detail, 0, 0, 0, 0, 0);
}

/// <summary>
/// Reading the queue, behind a seam.
///
/// <para>
/// <b>A seam and not an injected <c>JobStorage</c>, and the reason is written into this repository's
/// history.</b> <c>Hangfire:Enabled=false</c> — every test host, and any local run without a
/// background server — registers no Hangfire services at all, and the container validates
/// dependencies at start-up: the first cut of <see cref="IInviteQueue"/> injected
/// <c>IBackgroundJobClient</c> into <c>PlatformDirectory</c> and took the <em>whole host</em> down,
/// 611 of 901 tests failing at once, none of them about invites. Registered in both branches of
/// <c>AddTerenJobs</c>, exactly as <c>IPipelineQueue</c> and <c>IInviteQueue</c> are.
/// </para>
/// </summary>
public interface IJobQueueDepth
{
    JobQueueDepth Read();
}

/// <summary>Hangfire's monitoring API behind the seam.</summary>
public sealed class HangfireJobQueueDepth(JobStorage storage, ILogger<HangfireJobQueueDepth> logger)
    : IJobQueueDepth
{
    public JobQueueDepth Read()
    {
        try
        {
            var monitor = storage.GetMonitoringApi();

            // Summed across every queue rather than asked of `default`: the pipeline runs on its
            // own queue (EntryProcessingJob.QueueName), so a per-queue reading would have shown
            // zero on the one screen whose question is "is the money path backed up".
            var enqueued = 0;
            foreach (var queue in monitor.Queues())
            {
                enqueued += (int)queue.Length + (int)queue.Fetched.GetValueOrDefault();
            }

            return new JobQueueDepth(
                Available: true,
                Detail: null,
                Enqueued: enqueued,
                Scheduled: (int)monitor.ScheduledCount(),
                Processing: (int)monitor.ProcessingCount(),
                Failed: (int)monitor.FailedCount(),
                Servers: monitor.Servers().Count);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "The Hangfire job storage could not be read for the health page.");

            return JobQueueDepth.Unknown(JobQueueDepth.Unreadable);
        }
    }
}

/// <summary>
/// What answers when Hangfire is switched off. It reports unavailability rather than zeroes,
/// because a health page that showed an empty queue on a host with no job server would be telling
/// a founder the most reassuring possible version of the worst state the system has.
/// </summary>
public sealed class DisabledJobQueueDepth : IJobQueueDepth
{
    public JobQueueDepth Read() => JobQueueDepth.Unknown(JobQueueDepth.NotConfigured);
}
