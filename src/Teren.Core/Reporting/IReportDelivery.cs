namespace Teren.Core.Reporting;

/// <summary>
/// How a finished report leaves the building. One seam, so the relay stays swappable
/// (PROJECT.md §11, decided 2026-08-29: SMTP via MailKit, protocol rather than vendor SDK).
/// <para>
/// Only ever called from a Hangfire job. Email is an external service and never runs inside a
/// request the phone is waiting on (PROJECT.md principle 4).
/// </para>
/// </summary>
public interface IReportDelivery
{
    /// <summary>For logs and for the report row: which transport actually carried it.</summary>
    string Name { get; }

    /// <summary>
    /// Whether a relay is configured at all. False makes the report pass fail visibly with
    /// <see cref="ReportFailure.DeliveryNotConfigured"/> rather than the host refusing to boot —
    /// the same policy the AI keys get, and for the same reason: the capture and upload path
    /// needs no relay.
    /// </summary>
    bool IsConfigured { get; }

    /// <summary>
    /// Hands the message to the relay and waits for its answer.
    /// <para>
    /// Throws <see cref="ReportDeliveryException"/> on anything that is not an acceptance; the
    /// caller branches on <see cref="ReportDeliveryException.Kind"/>, never on the message text.
    /// </para>
    /// </summary>
    Task<ReportDeliveryReceipt> SendAsync(ReportMessage message, CancellationToken ct);

    /// <summary>
    /// Whether this transport can address that recipient at all.
    /// <para>
    /// It belongs to the transport because only the transport knows what a usable address looks
    /// like, and it is asked <em>before</em> anything is claimed or sent: a project whose
    /// distribution list is entirely typos should fail with
    /// <see cref="ReportFailure.RecipientsUnusable"/> having sent nothing, rather than half-send
    /// and leave the server unable to say what the client has.
    /// </para>
    /// </summary>
    bool CanAddress(ReportRecipient recipient);
}

/// <summary>One person on a project's distribution list, as stored in <c>project.recipients</c>.</summary>
public sealed record ReportRecipient(string? Name, string Email, string? Role);

/// <summary>
/// A report ready to be handed over: the addressing, the covering note, and the PDF itself.
/// The body is supplied in both plain text and HTML because a site diary is read on phones,
/// and a text/plain alternative is also what keeps a transactional mail out of spam filters.
/// </summary>
/// <param name="ReportId">
/// The <c>report</c> row this message *is*, carried for one reason: it is what makes a
/// <b>stable</b> <c>Message-ID</c> possible. Every attempt at the same row — a retry inside one
/// pass, a later pass reclaiming a failed row — carries the same id and therefore the same
/// header, so a receiving server can collapse two copies of the same report. That is the only
/// duplicate suppression SMTP offers at all, and a freshly generated id per attempt throws it
/// away.
/// </param>
public sealed record ReportMessage(
    Guid ReportId,
    IReadOnlyList<ReportRecipient> Recipients,
    string Subject,
    string BodyText,
    string BodyHtml,
    string AttachmentFileName,
    byte[] Attachment,
    string AttachmentContentType = "application/pdf");

/// <summary>
/// What the relay said, and nothing more than that.
/// <para>
/// The naming is deliberate. SMTP gives no bounce and no delivery telemetry (ARCHITECTURE §10),
/// so a <c>250 OK</c> means the relay took custody of the message — not that a person received
/// it, not that it escaped a spam folder. <see cref="HandedOverAt"/> is therefore the honest
/// name for what <c>report.sent_at</c> records, and nothing in this system claims "delivered".
/// </para>
/// </summary>
public sealed record ReportDeliveryReceipt(
    string Transport,
    string? RelayResponse,
    DateTimeOffset HandedOverAt,
    int RecipientCount);

/// <summary>What the relay refused, in a form the report pass can branch on.</summary>
public enum ReportDeliveryFailureKind
{
    /// <summary>
    /// The relay could not be reached, or refused, <b>before the message transaction began</b> —
    /// a connect, a greeting, a login, or a 4xx answer to an envelope command. Worth retrying,
    /// because nothing of the message had been transmitted when it failed.
    /// </summary>
    Transient,

    /// <summary>
    /// The conversation broke <b>after transmission began</b> and the relay never answered.
    /// <para>
    /// This is the classic duplicate-email vector and it is deliberately not retryable. A relay
    /// that scans content after DATA, or resets the connection after having accepted the
    /// message, leaves no way to tell "it never arrived" from "it arrived and the acknowledgement
    /// was lost". Retrying resolves that in the client's inbox, with a second copy of his site
    /// diary. So the pass stops exactly as it does for a report abandoned by a crash
    /// (<see cref="ReportFailure.ReportInterrupted"/>) — it says what it knows and a person
    /// decides (ARCHITECTURE §6).
    /// </para>
    /// </summary>
    CustodyUnknown,

    /// <summary>The relay refused permanently — a 5xx, an address it will not accept.</summary>
    Rejected,

    /// <summary>The relay refused our credentials. A deployment fault; no retry fixes it.</summary>
    Unauthorized,

    /// <summary>No relay is configured.</summary>
    NotConfigured,
}

/// <summary>
/// Delivery did not happen. <see cref="Retryable"/> and <see cref="Kind"/> carry the whole
/// decision, for the same reason <c>AiProviderException</c> does: a reworded SMTP banner must
/// never change what a foreman is told in Serbian.
/// </summary>
public class ReportDeliveryException(
    string transport,
    string message,
    ReportDeliveryFailureKind kind,
    Exception? inner = null)
    : Exception(message, inner)
{
    public string Transport { get; } = transport;

    public ReportDeliveryFailureKind Kind { get; } = kind;

    public bool Retryable => Kind == ReportDeliveryFailureKind.Transient;
}
