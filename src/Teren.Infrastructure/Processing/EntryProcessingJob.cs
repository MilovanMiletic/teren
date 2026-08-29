using Hangfire;
using Hangfire.Server;
using Microsoft.Extensions.Logging;

namespace Teren.Infrastructure.Processing;

/// <summary>
/// The Hangfire entry points. Deliberately thin — everything worth testing lives in
/// <see cref="EntryProcessor"/> and <see cref="PipelineSweeper"/>, which know nothing about
/// Hangfire and therefore need no background server to prove.
/// </summary>
/// <remarks>
/// <para>
/// <c>AutomaticRetry(Attempts = 0)</c> is not an oversight. The processor owns its own bounded
/// retry policy and, when it gives up, ends by writing a visible <c>needs_review</c> state — a
/// completed job, as far as Hangfire is concerned. Letting Hangfire retry on top of that would
/// re-run a pass that already reached its verdict, and stack two independent retry budgets whose
/// product nobody has reasoned about. The one case Hangfire's retry would have covered — the
/// process dying mid-pass — is covered instead by the sweeper, which parks the entry where a
/// person can see it.
/// </para>
/// </remarks>
public sealed class EntryProcessingJob(
    EntryProcessor processor, ILogger<EntryProcessingJob> logger)
{
    public const string QueueName = "entries";

    [AutomaticRetry(Attempts = 0)]
    [Queue(QueueName)]
    [JobDisplayName("Process entry {0}")]
    public async Task RunAsync(Guid entryId, Guid companyId, IJobCancellationToken cancellation)
    {
        var ct = cancellation.ShutdownToken;

        var outcome = await processor.ProcessAsync(entryId, companyId, ct);

        logger.LogInformation(
            "Entry {EntryId} processing finished with outcome {Outcome}.", entryId, outcome);
    }
}

/// <summary>The recurring sweep. Same reasoning about retries as above.</summary>
public sealed class PipelineSweepJob(PipelineSweeper sweeper)
{
    public const string RecurringJobId = "pipeline-sweep";

    [AutomaticRetry(Attempts = 0)]
    [Queue(EntryProcessingJob.QueueName)]
    [JobDisplayName("Sweep for entries the pipeline has not picked up")]
    public Task RunAsync(IJobCancellationToken cancellation) =>
        sweeper.SweepAsync(cancellation.ShutdownToken);
}
