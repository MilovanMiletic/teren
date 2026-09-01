namespace Teren.Core.Entities;

/// <summary>
/// One diary entry, captured on the phone. Evidence-grade: once <see cref="ReportedAt"/> is set
/// the row is immutable (enforced in <c>TerenDbContext</c> and by a Postgres trigger);
/// corrections are new entries pointing back via <see cref="SupersedesEntryId"/>.
/// </summary>
public sealed class Entry
{
    /// <summary>Generated on the phone. Doubles as the idempotency key — never generated server-side.</summary>
    public Guid Id { get; set; }

    public Guid CompanyId { get; set; }
    public Guid ProjectId { get; set; }
    public DateOnly EntryDate { get; set; }
    public EntryStatus Status { get; set; }

    /// <summary>Raw evidence. Write-once: never edited, never overwritten (trigger-enforced).</summary>
    public string? RawTranscript { get; set; }

    /// <summary>JSON: what the model extracted. Carries schema_version. Never overwritten by <see cref="Corrected"/>.</summary>
    public string? Structure { get; set; }

    /// <summary>JSON: what the human approved (may equal Structure). Carries schema_version.
    /// The (RawTranscript, Structure, Corrected) triple is the product's training signal.</summary>
    public string? Corrected { get; set; }

    /// <summary>JSON: conditions for the entry's date and location.</summary>
    public string? Weather { get; set; }

    /// <summary>Capture coordinates from the Geolocation API (WGS84), with reported accuracy.</summary>
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public double? GpsAccuracyM { get; set; }

    /// <summary>Set on a correction entry: the reported entry this one supersedes.</summary>
    public Guid? SupersedesEntryId { get; set; }

    public Guid? DeviceId { get; set; }

    /// <summary>
    /// The worker whose credential recorded this entry. Provenance, and the point of the whole
    /// identity model: a site diary that cannot say <em>who</em> recorded a day is weaker than the
    /// notebook it replaces.
    /// <para>
    /// Derived from the bearer, never from the request body — the same rule as
    /// <see cref="DeviceId"/>, and for a stronger reason: a phone that could name its own author
    /// could sign a day's evidence with another man's name.
    /// </para>
    /// <para>
    /// <b>Nullable, and every row that existed before D8 keeps a null.</b> There is deliberately
    /// no backfill: standing the immutability guard down to write a plausible author onto reported
    /// evidence would be inventing provenance, which is the one thing this column exists to stop.
    /// Null means "recorded before Teren tracked people", and that is the honest answer.
    /// </para>
    /// </summary>
    public Guid? CreatedByUserId { get; set; }

    /// <summary>
    /// Who approved what the report would say (PROJECT.md principle 5's gate).
    /// <para>
    /// Separate from <see cref="CreatedByUserId"/> because they are separate acts and can be
    /// separate people — a phone handed over mid-shift, a foreman confirming from a second device.
    /// Stamped on the confirmation that <em>changes</em> the entry, and left alone by a replay,
    /// exactly as <see cref="ConfirmedAt"/> is: it records who decided, not whose retry timer
    /// fired last.
    /// </para>
    /// </summary>
    public Guid? ConfirmedByUserId { get; set; }

    /// <summary>When the phone captured it (client clock, UTC).</summary>
    public DateTime CreatedAt { get; set; }

    /// <summary>When the server accepted it (server clock, UTC).</summary>
    public DateTime? ReceivedAt { get; set; }

    public DateTime? ConfirmedAt { get; set; }

    /// <summary>Once set, the row is immutable.</summary>
    public DateTime? ReportedAt { get; set; }

    /// <summary>Why the pipeline parked it in needs_review, if it did.</summary>
    public string? FailureReason { get; set; }

    /// <summary>
    /// When the pipeline claimed this entry (server clock, UTC). Set by the atomic claim that
    /// moves <c>received</c> to <c>processing</c>, and the only way to tell an entry that is
    /// being worked on from one abandoned by a process restart: the sweeper parks anything that
    /// has been <c>processing</c> longer than <c>Pipeline:StaleProcessingAfter</c>. Without it a
    /// crash mid-job would leave an entry invisible forever, which is data loss with extra steps.
    /// </summary>
    public DateTime? ProcessingStartedAt { get; set; }
}
