using Hangfire;
using Microsoft.Extensions.Logging;

namespace Teren.Api.Jobs;

/// <summary>
/// Queueing an invite mail, behind a seam.
///
/// <para>
/// <b>Why this exists rather than injecting <c>IBackgroundJobClient</c> directly.</b> Because that
/// is what the first cut did, and <c>Hangfire:Enabled=false</c> — which is every test host and any
/// local run without a background server — does not register one. The DI container validates
/// scoped descriptors at start-up, so a single unresolvable dependency on
/// <c>PlatformDirectory</c> took the **whole host** down: 611 of 901 backend tests failed at
/// once, none of them about invites. <c>IPipelineQueue</c> had already learned this lesson and
/// this is the same shape, registered in the same two branches of <c>AddTerenJobs</c>.
/// </para>
/// </summary>
public interface IInviteQueue
{
    /// <summary>True when a job was actually queued. **False is not an error and must reach the
    /// screen**: the account exists and nobody can get into it, which is a thing a founder has to
    /// be told rather than left to discover.</summary>
    bool EnqueueInvite(Guid userId, Guid actorUserId);
}

/// <summary>Hangfire behind the seam.</summary>
public sealed class HangfireInviteQueue(
    IBackgroundJobClient jobs, ILogger<HangfireInviteQueue> logger) : IInviteQueue
{
    public bool EnqueueInvite(Guid userId, Guid actorUserId)
    {
        jobs.Enqueue<AdminInviteJob>(job => job.RunAsync(userId, actorUserId, CancellationToken.None));

        // The id and nothing else — never the address (ARCHITECTURE §12).
        logger.LogInformation("Invite mail queued for {UserId}.", userId);
        return true;
    }
}

/// <summary>
/// What runs when Hangfire is switched off.
///
/// <para>
/// It logs loudly rather than throwing, exactly as <c>DisabledPipelineQueue</c> does: refusing
/// would fail a request that has already created the account, and the account is not lost — it
/// sits there with <c>password_pending</c> true, which is the state the founder's own directory
/// filter is built to surface. He presses "send again" on the person page once a worker runs.
/// </para>
/// </summary>
public sealed class DisabledInviteQueue(ILogger<DisabledInviteQueue> logger) : IInviteQueue
{
    public bool EnqueueInvite(Guid userId, Guid actorUserId)
    {
        logger.LogWarning(
            "Background jobs are disabled (Hangfire:Enabled=false); no invite mail was sent for "
            + "{UserId}. The account exists and is waiting for a password.", userId);
        return false;
    }
}
