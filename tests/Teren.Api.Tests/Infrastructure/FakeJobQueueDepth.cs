using Teren.Api.Jobs;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// The job queue, stopped at the seam <c>PlatformDirectory</c> reads it through.
///
/// <para>
/// The test host runs with <c>Hangfire__Enabled=false</c>, so the container's own answer is
/// <c>DisabledJobQueueDepth</c> — permanently "unknown". That is a real state and worth a test of
/// its own, but it would leave the numeric half of the health response unprovable, and the numeric
/// half is what a founder reads. So the seam is substitutable, exactly as
/// <c>IPipelineQueue</c> and <c>IReportDelivery</c> are.
/// </para>
/// </summary>
public sealed class FakeJobQueueDepth : IJobQueueDepth
{
    /// <summary>
    /// Defaults to the honest answer for a host with no job server, so a test that says nothing
    /// about the queue is not silently asserting against numbers nobody arranged.
    /// </summary>
    public JobQueueDepth Depth { get; set; } =
        JobQueueDepth.Unknown(JobQueueDepth.NotConfigured);

    public JobQueueDepth Read() => Depth;
}
