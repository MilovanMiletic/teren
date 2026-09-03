using Teren.Api.Jobs;
using Teren.Core.Mail;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// The mail-job queue, recorded instead of queued.
///
/// <para>
/// <b>Why the container's own answer is not enough, and this is the lesson of the
/// <c>IJobQueueDepth</c> fixture.</b> The test host runs with <c>Hangfire__Enabled=false</c>, so
/// the real registration is <c>DisabledInviteQueue</c>: it logs and returns false, and a route's
/// request for a job is therefore unobservable — the whole notification half of §13.6 would be
/// provable only by reading the code. This records what was asked for.
/// </para>
///
/// <para>
/// <b>It is deliberately not proof that the shipped queue enqueues anything.</b> A seam can swallow
/// a lie: that <c>HangfireInviteQueue</c> creates the right job, with the right arguments, and with
/// no credential among them, is proven separately against a recording
/// <c>IBackgroundJobClient</c> in <c>MailJobArgumentTests</c>. This double answers only "did the
/// handler ask?".
/// </para>
/// </summary>
public sealed class RecordingInviteQueue : IInviteQueue
{
    /// <summary>
    /// What <see cref="EnqueueInvite"/> answers.
    ///
    /// <para>
    /// <b>False by default, which is the shipped answer on this host</b> — Hangfire is off, so
    /// nothing is queued and <c>emailed</c> is false, and several tests assert exactly that. A test
    /// that needs the <em>consequences</em> of a queued invite — the access notice is only asked
    /// for when a credential actually went out — sets it true and says why.
    /// </para>
    /// </summary>
    public bool InviteSucceeds { get; set; }

    public List<(Guid UserId, Guid ActorUserId, AdminAccessNotice Notice)> Invites { get; } = [];

    public List<Guid> WorkerCodeMails { get; } = [];

    public List<(Guid SubjectUserId, AdminAccessNotice Notice, DateTime OccurredAt)> Notices { get; }
        = [];

    public bool EnqueueInvite(Guid userId, Guid actorUserId, AdminAccessNotice notice)
    {
        Invites.Add((userId, actorUserId, notice));
        return InviteSucceeds;
    }

    public void EnqueueWorkerCodeMail(Guid userId) => WorkerCodeMails.Add(userId);

    public void EnqueueAdminAccessNotice(
        Guid subjectUserId, AdminAccessNotice notice, DateTime occurredAt) =>
        Notices.Add((subjectUserId, notice, occurredAt));

    public void Reset()
    {
        InviteSucceeds = false;
        Invites.Clear();
        WorkerCodeMails.Clear();
        Notices.Clear();
    }
}
