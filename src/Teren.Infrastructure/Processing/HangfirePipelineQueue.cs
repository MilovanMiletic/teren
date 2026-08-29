using Hangfire;
using Microsoft.Extensions.Logging;
using Teren.Core.Processing;

namespace Teren.Infrastructure.Processing;

/// <summary>Hangfire behind the <see cref="IPipelineQueue"/> seam.</summary>
public sealed class HangfirePipelineQueue(
    IBackgroundJobClient jobs, ILogger<HangfirePipelineQueue> logger) : IPipelineQueue
{
    public void EnqueueProcessing(Guid entryId, Guid companyId)
    {
        jobs.Enqueue<EntryProcessingJob>(
            job => job.RunAsync(entryId, companyId, null!));

        logger.LogInformation("Entry {EntryId} queued for processing.", entryId);
    }

    public void EnqueueReport(Guid entryId, Guid companyId)
    {
        jobs.Enqueue<EntryReportJob>(job => job.RunAsync(entryId, companyId, null!));

        logger.LogInformation("Entry {EntryId} queued for reporting.", entryId);
    }
}

/// <summary>
/// What runs when Hangfire is switched off (<c>Hangfire:Enabled=false</c>) — a local run with no
/// background server, or a test host.
/// <para>
/// It logs loudly rather than throwing, because refusing the enqueue would fail a
/// <c>/complete</c> that has already sealed the evidence set, and the entry is not lost either
/// way: it sits in <c>received</c> with a receipt, which is precisely the state the sweeper
/// picks up the moment a server does run.
/// </para>
/// </summary>
public sealed class DisabledPipelineQueue(ILogger<DisabledPipelineQueue> logger) : IPipelineQueue
{
    public void EnqueueProcessing(Guid entryId, Guid companyId) =>
        logger.LogWarning(
            "Background processing is disabled (Hangfire:Enabled=false); entry {EntryId} stays "
            + "in `received` and will be picked up when a worker runs.", entryId);

    public void EnqueueReport(Guid entryId, Guid companyId) =>
        logger.LogWarning(
            "Background processing is disabled (Hangfire:Enabled=false); entry {EntryId} stays "
            + "`confirmed` and its report will be sent when a worker runs.", entryId);
}
