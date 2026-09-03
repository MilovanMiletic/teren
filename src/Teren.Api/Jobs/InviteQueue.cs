using Hangfire;
using Microsoft.Extensions.Logging;
using Teren.Core.Mail;

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
    /// <summary>
    /// True when a job was actually queued. **False is not an error and must reach the screen**:
    /// the account exists and nobody can get into it, which is a thing a founder has to be told
    /// rather than left to discover.
    /// </summary>
    /// <param name="notice">
    /// What the company's other administrators are told once the link has actually gone out — a
    /// new administrator, or a credential on an account that already existed
    /// (<see cref="AdminAccessNoticeJob"/>, plan §13.6). Carried through the invite rather than
    /// announced at the request, because the request cannot know whether the mail will be sent.
    /// </param>
    bool EnqueueInvite(Guid userId, Guid actorUserId, AdminAccessNotice notice);

    /// <summary>
    /// The worker half: mail one man his own activation code (<see cref="WorkerCodeMailJob"/>).
    /// <para>
    /// <b>The answer is deliberately not reported to anyone</b>, unlike an invite's.
    /// <c>POST /auth/activation-code</c> is unauthenticated and answers 202 whatever happens —
    /// telling the caller whether a job was queued would say whether that username exists and has
    /// an address on file, which is the one fact §10.3 exists to hide. The queue and the job log
    /// what happened; the response never does.
    /// </para>
    /// </summary>
    void EnqueueWorkerCodeMail(Guid userId);

    /// <summary>
    /// The notice half (<see cref="AdminAccessNoticeJob"/>): tell a company's <em>other</em>
    /// administrators that Teren staff changed administrative access inside their company.
    /// <para>
    /// <b>Nothing is reported to the caller</b>, unlike an invite's answer, and that is deliberate.
    /// Whether anybody was told depends on how many other administrators the company has, which is
    /// a fact about the customer rather than about the request; and a screen that said "3
    /// administrators notified" would invite somebody to treat it as a knob. The job and the log
    /// stream record what happened, and the <c>admin_audit</c> row is what proves the act itself.
    /// </para>
    /// </summary>
    void EnqueueAdminAccessNotice(
        Guid subjectUserId, AdminAccessNotice notice, DateTime occurredAt);
}

/// <summary>Hangfire behind the seam.</summary>
public sealed class HangfireInviteQueue(
    IBackgroundJobClient jobs, ILogger<HangfireInviteQueue> logger) : IInviteQueue
{
    public bool EnqueueInvite(Guid userId, Guid actorUserId, AdminAccessNotice notice)
    {
        jobs.Enqueue<AdminInviteJob>(job =>
            job.RunAsync(userId, actorUserId, notice, CancellationToken.None));

        // The id and nothing else — never the address (ARCHITECTURE §12).
        logger.LogInformation("Invite mail queued for {UserId}.", userId);
        return true;
    }

    public void EnqueueWorkerCodeMail(Guid userId) =>
        jobs.Enqueue<WorkerCodeMailJob>(job => job.RunAsync(userId, CancellationToken.None));

    public void EnqueueAdminAccessNotice(
        Guid subjectUserId, AdminAccessNotice notice, DateTime occurredAt)
    {
        jobs.Enqueue<AdminAccessNoticeJob>(job =>
            job.RunAsync(subjectUserId, notice, occurredAt, CancellationToken.None));

        // The id and the kind. Never an address, and there is no credential to omit.
        logger.LogInformation(
            "Access notice queued for {SubjectId} ({Reason}).", subjectUserId, notice.ToString());
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
    public bool EnqueueInvite(Guid userId, Guid actorUserId, AdminAccessNotice notice)
    {
        logger.LogWarning(
            "Background jobs are disabled (Hangfire:Enabled=false); no invite mail was sent for "
            + "{UserId}. The account exists and is waiting for a password.", userId);
        return false;
    }

    public void EnqueueWorkerCodeMail(Guid userId) =>
        // Nothing is minted here, which is the safe direction: with no job server the worker's
        // live code survives and his admin reads him one off /company.
        logger.LogWarning(
            "Background jobs are disabled (Hangfire:Enabled=false); no activation-code mail was "
            + "sent for {UserId}, and his live code is untouched.", userId);

    public void EnqueueAdminAccessNotice(
        Guid subjectUserId, AdminAccessNotice notice, DateTime occurredAt) =>
        // Warning rather than silence, and it is the loudest line in this class: on a host with no
        // job server the invite itself was not queued either (`EnqueueInvite` above returns false
        // and the screen says so), so nothing was handed out — but if that ever stops being true,
        // this line is the only trace that a customer was not told.
        logger.LogWarning(
            "Background jobs are disabled (Hangfire:Enabled=false); the company's other "
            + "administrators were NOT told about {SubjectId} ({Reason}).",
            subjectUserId, notice.ToString());
}
