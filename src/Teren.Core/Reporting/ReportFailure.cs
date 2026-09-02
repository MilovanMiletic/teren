namespace Teren.Core.Reporting;

/// <summary>
/// The vocabulary of a failed report pass, stored both on <c>report.failure_reason</c> and on
/// <c>entry.failure_reason</c> as <c>"{code}: {detail}"</c> — the same shape
/// <see cref="Processing.ProcessingFailure"/> uses, for the same reason: the phone must be able
/// to tell "nobody is on the distribution list" from "the mail relay refused the address"
/// without parsing English prose.
/// </summary>
public static class ReportFailure
{
    /// <summary>The project has no recipients. There is no inbox for the report to land in, and
    /// an entry nobody was sent is not a reported entry.</summary>
    public const string NoRecipients = "no_recipients";

    /// <summary>Every recipient on the project has an address the mail library will not accept.</summary>
    public const string RecipientsUnusable = "recipients_unusable";

    /// <summary>No relay is configured. Same treatment as a missing AI key: honest, visible, and
    /// never a host that refuses to boot.</summary>
    public const string DeliveryNotConfigured = "delivery_not_configured";

    /// <summary>A photo hashes to something other than what the phone declared. The evidence set
    /// is not what was captured, so no PDF is produced from it (ARCHITECTURE §6).</summary>
    public const string PhotoChecksumMismatch = "photo_checksum_mismatch";

    /// <summary>A photo verified at <c>/complete</c> is not in storage now.</summary>
    public const string PhotoMissing = "photo_missing";

    /// <summary>Storage could not be read at all; the bytes may still be fine.</summary>
    public const string StorageUnavailable = "storage_unavailable";

    /// <summary>Gathering the evidence and laying out the PDF ran past
    /// <c>Reporting:RenderBudget</c>. Nothing was sent, so this is safe to try again.</summary>
    public const string RenderTimeout = "render_timeout";

    /// <summary>The document could not be produced at all.</summary>
    public const string RenderFailed = "render_failed";

    /// <summary>
    /// <c>project.time_zone</c> is not an IANA id this host can resolve, so no timestamp on the
    /// document can be printed in the site's local time. Its own code rather than a
    /// <see cref="RenderFailed"/> because it is a one-column configuration mistake with an obvious
    /// fix, not a layout engine that fell over — and because the alternative to stopping is a
    /// report whose times are quietly an hour wrong.
    /// </summary>
    public const string TimeZoneUnknown = "time_zone_unknown";

    /// <summary>Nothing to put in a report: no work, no materials, no notes, no photos.</summary>
    public const string NothingToReport = "nothing_to_report";

    /// <summary>The relay refused the message permanently — a bad address, a rejected sender.
    /// Retrying sends the same refusal.</summary>
    public const string DeliveryRejected = "delivery_rejected";

    /// <summary>The relay refused our credentials. A configuration fault, not a transient one.</summary>
    public const string DeliveryUnauthorized = "delivery_unauthorized";

    /// <summary>The relay could not be reached, or gave up, after every attempt.</summary>
    public const string DeliveryFailed = "delivery_failed";

    /// <summary>
    /// A report was claimed and never finished — almost always a process restart mid-send.
    /// <para>
    /// Deliberately terminal until a human looks at it. SMTP hands back no message id and no
    /// delivery telemetry (ARCHITECTURE §10), so a pass that died around the relay call leaves
    /// the server genuinely unable to say whether the client has the report. Re-sending on a
    /// guess would put a second copy of a site diary in an investor's inbox; refusing to guess
    /// leaves a visible reason and a person to decide.
    /// </para>
    /// </summary>
    public const string ReportInterrupted = "report_interrupted";

    /// <summary>
    /// The relay conversation broke after the message had begun transmitting and the relay never
    /// answered — a scanner slower than the conversation budget, a reset after acceptance.
    /// <para>
    /// The sibling of <see cref="ReportInterrupted"/> and terminal for the same reason: the
    /// server cannot say whether the relay took the message, so it does not guess. The difference
    /// is only where the pass died — inside the SMTP conversation rather than anywhere in the
    /// pass — and both leave the client's custody of the report unknown.
    /// </para>
    /// </summary>
    public const string DeliveryCustodyUnknown = "delivery_custody_unknown";

    /// <summary>
    /// A newer confirmation replaced the content this pass was about to report, so it released
    /// its claim and sent nothing. Not a fault and not custody-unknown: the replacement pass
    /// sends the report, and the entry is deliberately left with no reason on it so the sweeper
    /// still covers a lost enqueue.
    /// </summary>
    public const string Superseded = "superseded";

    /// <summary>
    /// <b>A report was delivered, and the entry now holds different content, so it was not
    /// sealed.</b>
    /// <para>
    /// The sibling of <see cref="Superseded"/> from the other side of the relay call. There, a
    /// newer confirmation arrived before anything was sent and the pass simply released its claim.
    /// Here the document had already gone out — the confirmation's read beat the claim and its
    /// write landed after the pass re-read <c>corrected</c>, which is a window neither check can
    /// close on its own — and <c>reported_at</c> is irreversible, so it is not stamped on content
    /// nobody received.
    /// </para>
    /// <para>
    /// <b>Terminal until a person acts, and it cannot be otherwise.</b> <c>ux_report_entry_id</c>
    /// allows one report per entry and there is no <c>sent → sending</c> transition, so the newer
    /// content can never get its own report of this entry; sending a second document for one day
    /// is exactly what §6 refuses. The product's answer is the one it already has for a correction
    /// after a report: a new entry carrying <c>supersedes_entry_id</c>.
    /// </para>
    /// <para>
    /// Not <see cref="IsCustodyUnknown"/>: custody here is <em>known</em> — the client has the
    /// earlier version. What is not true is that the archive's current version was ever sent.
    /// </para>
    /// </summary>
    public const string SupersededAfterSend = "superseded_after_send";

    /// <summary>Anything the report pass did not anticipate. Still visible, still not lost.</summary>
    public const string Unexpected = "unexpected";

    public static string Describe(string code, string detail) => $"{code}: {detail}";

    /// <summary>
    /// Whether this reason means <b>the server cannot say whether the client has the report</b>.
    /// <para>
    /// The one class of failure that must never be retried by anything automatic — not by the
    /// sweeper, not by a phone replaying its confirmation over a flaky link, not by a later pass
    /// reclaiming the row. ARCHITECTURE §6: "a report abandoned mid-send is never re-sent
    /// automatically … a person decides." Guessing "it never arrived" puts a second copy of a
    /// site diary in an investor's inbox; guessing "it did" seals an entry that was never sent.
    /// </para>
    /// </summary>
    public static bool IsCustodyUnknown(string? failureReason) =>
        CodeOf(failureReason) is ReportInterrupted or DeliveryCustodyUnknown;

    /// <summary>
    /// The stored-reason prefixes of <see cref="IsCustodyUnknown"/>, for the one place that has
    /// to ask the question in SQL rather than in C# — the claim predicate, where the check has to
    /// be part of the same conditional UPDATE to be race-proof.
    /// </summary>
    public const string ReportInterruptedPrefix = ReportInterrupted + ":";

    /// <inheritdoc cref="ReportInterruptedPrefix"/>
    public const string DeliveryCustodyUnknownPrefix = DeliveryCustodyUnknown + ":";

    /// <summary>The code half of a stored reason, for tests and for the UI.</summary>
    public static string CodeOf(string? failureReason)
    {
        if (string.IsNullOrEmpty(failureReason))
        {
            return string.Empty;
        }

        var separator = failureReason.IndexOf(':');
        return separator < 0 ? failureReason : failureReason[..separator];
    }
}
