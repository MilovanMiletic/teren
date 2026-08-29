namespace Teren.Core.Entities;

public enum ReportKind
{
    Daily,
    Weekly,
}

/// <summary>
/// Where a report is in the one thing that can go wrong asynchronously: getting it out.
/// <para>
/// There is deliberately no <c>rendering</c> state. The row is only created once the PDF exists
/// in storage, because until then nothing has happened that anybody outside this process could
/// observe, and a claim that guards nothing is a row that can strand.
/// </para>
/// </summary>
public enum ReportStatus
{
    /// <summary>Rendered and stored; the relay conversation is in progress. Also the claim: one
    /// row per entry, so exactly one pass can be here at a time.</summary>
    Sending,

    /// <summary>The relay took custody. **Not** "the client read it" — SMTP tells us nothing
    /// about that (ARCHITECTURE §10).</summary>
    Sent,

    /// <summary>The attempt ended without the relay accepting it. The reason is on the row.</summary>
    Failed,
}

/// <summary>
/// A generated PDF report covering one or more entries of a project, and the record of what was
/// done with it.
/// <para>
/// For a daily report the row is also the **claim** on that entry's report: <see cref="EntryId"/>
/// is unique, so two concurrent passes cannot both send. It is created only after the PDF is in
/// storage and immediately before the relay is called, which makes the window in which the
/// server cannot say whether a client has the report as small as SMTP allows it to be.
/// </para>
/// </summary>
public sealed class Report
{
    public Guid Id { get; set; }
    public Guid CompanyId { get; set; }
    public Guid ProjectId { get; set; }

    /// <summary>
    /// The entry this daily report is about. Unique where set — one entry, one report — which
    /// is what makes an enqueue idempotent and a double-send impossible.
    /// <para>
    /// Null for a report that covers a period rather than a single entry (the weekly recap,
    /// ROADMAP C6), which is why the column is nullable rather than required.
    /// </para>
    /// </summary>
    public Guid? EntryId { get; set; }

    public ReportKind Kind { get; set; }
    public DateOnly PeriodStart { get; set; }
    public DateOnly PeriodEnd { get; set; }
    public string? PdfObjectKey { get; set; }

    /// <summary>
    /// SHA-256 of the PDF bytes as they were stored and handed to the relay.
    /// <para>
    /// The same obligation the product already carries for a photograph, pointed the other way:
    /// <c>/complete</c> verifies size only, so bytes are checked wherever they are actually read
    /// (ARCHITECTURE §6, review F3). <c>GET /api/entries/{id}/report</c> reads these bytes back
    /// out of storage months later, and without a recorded hash "here is your evidence document"
    /// would rest on nothing but the object store having been careful.
    /// </para>
    /// <para>
    /// Nullable for rows written before this column existed; those are served unverified with a
    /// log line rather than refused, because a report that was genuinely sent must stay
    /// retrievable.
    /// </para>
    /// </summary>
    public string? PdfSha256 { get; set; }

    /// <summary>JSON: [{name, email, role}] — snapshot of who it was sent to, as the distribution
    /// list stood at that moment. Editing the project later never rewrites history.</summary>
    public string? Recipients { get; set; }

    public ReportStatus Status { get; set; }

    /// <summary>When the relay took custody. Null while <see cref="Status"/> is not
    /// <see cref="ReportStatus.Sent"/>.</summary>
    public DateTime? SentAt { get; set; }

    /// <summary>
    /// What the transport reported when it accepted the message — the relay's own response line.
    /// Kept on the row rather than only in a log, because "we handed it over and it said this"
    /// is the strongest claim this system can honestly make about a report.
    /// </summary>
    public string? DeliveryDetail { get; set; }

    /// <summary>How many passes have tried to deliver this report.</summary>
    public int Attempts { get; set; }

    /// <summary>When the current attempt claimed the row. The sweeper uses it to find a pass
    /// that was abandoned mid-send, exactly as <c>entry.processing_started_at</c> does.</summary>
    public DateTime? AttemptStartedAt { get; set; }

    /// <summary><c>"{code}: {detail}"</c> from <c>ReportFailure</c>, when the attempt failed.</summary>
    public string? FailureReason { get; set; }

    public DateTime CreatedAt { get; set; }
}
