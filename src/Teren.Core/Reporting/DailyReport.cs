namespace Teren.Core.Reporting;

/// <summary>
/// Everything one daily report puts on paper, already resolved: no database, no JSON, no
/// storage. The renderer takes this and produces bytes, which is what makes the layout
/// testable and the gathering — checksum verification included — testable separately.
/// </summary>
/// <param name="Language">
/// The **project's** report language, not the foreman's phone setting (ARCHITECTURE §6:
/// <c>project.report_language</c>). This is the client's language: a foreign investor gets an
/// English report out of the same machinery that sends his neighbour a Serbian one.
/// </param>
/// <param name="TimeZoneId">
/// The **project's** zone (<c>project.time_zone</c>), an IANA id — the same per-project shape as
/// <paramref name="Language"/>, and for the same reason: what matters is where the site is, not
/// where the server or the foreman's phone is. Every timestamp on the page is converted to it at
/// render time; storage stays UTC throughout (<see cref="ReportTimeZone"/>).
/// </param>
public sealed record DailyReport(
    string CompanyName,
    string ProjectName,
    string? ProjectAddress,
    DateOnly Date,
    string Language,
    string TimeZoneId,
    ReportContent Content,
    IReadOnlyList<ReportPhoto> Photos,
    ReportProvenance Provenance)
{
    /// <summary>
    /// The document this one replaces, when this entry is a correction
    /// (<c>entry.supersedes_entry_id</c>); null for an ordinary day, and then nothing extra is
    /// printed at all.
    /// <para>
    /// **Why it has to be on the page.** A correction already exists as a record — the phone can
    /// make one and the link is stored — but the PDF the client receives said nothing about the
    /// document it replaces, so it arrived looking like an unrelated day. That is weak evidence in
    /// precisely the dispute a correction exists for: the client has *already received* the wrong
    /// report.
    /// </para>
    /// <para>
    /// An <c>init</c> property rather than a tenth positional parameter, for the same reason
    /// <see cref="ReportContent.DescribedVerbatim"/> is one: this is not another section of the
    /// day, it is a statement about the standing of the whole document.
    /// </para>
    /// </summary>
    public ReportCorrection? Correction { get; init; }
}

/// <summary>
/// The predecessor, named the way a human would name it (founder, PROJECT.md §11: the report is a
/// client's document, not a system record).
///
/// <para>
/// <b>No GUID.</b> Ruling 1 took the record id off this page deliberately — "a GUID means nothing
/// to an investor" — and the accepted trade-off is that a disputed PDF is matched to the archive by
/// **project + date**. So that is the pair printed here: the superseded record's own work date,
/// which is what a client can look up in his inbox and a contractor in his archive.
/// </para>
/// </summary>
/// <param name="Date">
/// The superseded entry's <c>entry_date</c> — the day of work, not the day the document was made.
/// </param>
/// <param name="SiteName">
/// Normally null, and printed only when it is not: the site the superseded record belongs to, when
/// that is <em>not</em> this report's own site.
/// <para>
/// <c>POST /entries</c> refuses a link to an entry of any other project, so a correction and its
/// predecessor share a site and the date alone identifies the document — which is exactly why the
/// site is *not* printed in the ordinary case (it is already in the masthead, the footer and the
/// record block). This carries the abnormal case rather than trusting it cannot happen: a row
/// written before that check existed, or by hand, would otherwise have a bare date on the page
/// naming a document from a different site — the one way this line could be worse than silence.
/// </para>
/// </param>
/// <param name="ReportSentAt">
/// When a relay took custody of the superseded report, or null if it never did.
/// <para>
/// Read from the <c>report</c> row rather than from the superseded entry's <c>reported_at</c>, and
/// the difference is load-bearing: the <c>superseded_after_send</c> case is a report that
/// <b>went out</b> and an entry that was deliberately left unsealed. Keying on the seal would print
/// "never sent" over a day the client is holding in his inbox, which is the worst thing this line
/// could say.
/// </para>
/// </param>
public sealed record ReportCorrection(
    DateOnly Date,
    string? SiteName,
    DateTimeOffset? ReportSentAt);

/// <summary>The structured day, parsed out of the entry's <c>corrected</c> JSONB (schema v1).</summary>
public sealed record ReportContent(
    IReadOnlyList<WorkDoneItem> WorkDone,
    ReportHeadcount? Headcount,
    IReadOnlyList<MaterialItem> Materials,
    IReadOnlyList<BlockerItem> Blockers,
    IReadOnlyList<HiddenWorkItem> HiddenWork,
    string? Notes)
{
    /// <summary>
    /// The day is the foreman's own words rather than a structured extraction — the
    /// <c>described_verbatim</c> flag the confirmation screen sets when he approves his own
    /// transcript as the record (founder, 2026-08-29, PROJECT.md §11).
    /// <para>
    /// **Why this exists at all.** Extraction can be down — an expired API key is enough — and
    /// the alternative for the foreman is typing his whole day by hand, which is the exact work
    /// the product exists to remove. So the floor is "a timestamped, geotagged, voice-backed
    /// record in his own words" and he finishes the day in one tap. What it must never become is
    /// a silent downgrade: without this flag the renderer would lay out an empty structured
    /// day — no work, no materials — on a document a client reads, which is worse than useless.
    /// </para>
    /// <para>
    /// An <c>init</c> property rather than a seventh positional parameter on purpose: this is not
    /// another section of the day, it is a statement about **where the whole description came
    /// from**, and it changes how <see cref="Notes"/> is presented rather than adding to it.
    /// </para>
    /// </summary>
    public bool DescribedVerbatim { get; init; }

    /// <summary>
    /// The flag *and* words to put under it. A <c>described_verbatim</c> entry with a blank note
    /// carries no description at all, and a page that announced a verbatim transcript and then
    /// showed none would be the one claim on this document nothing backs. Everything that marks
    /// the day as his own words keys on this rather than on the raw flag.
    /// </summary>
    public bool HasVerbatimDescription =>
        DescribedVerbatim && !string.IsNullOrWhiteSpace(Notes);

    public static ReportContent Empty { get; } =
        new([], null, [], [], [], null);

    /// <summary>
    /// Nothing a client could read. A report with no work, no materials, no blockers, no hidden
    /// work and no note is an empty page with a letterhead — worse than no report, because it
    /// says the day was documented when it was not.
    /// <para>
    /// <see cref="DescribedVerbatim"/> deliberately does not rescue an empty day: the flag on its
    /// own is a claim, not content. A verbatim entry passes here on the strength of its
    /// transcript in <see cref="Notes"/>, exactly like any other note would.
    /// </para>
    /// </summary>
    public bool IsEmpty =>
        WorkDone.Count == 0
        && Materials.Count == 0
        && Blockers.Count == 0
        && HiddenWork.Count == 0
        && string.IsNullOrWhiteSpace(Notes)
        && Headcount is null;
}

public sealed record WorkDoneItem(string Description, string? Location, ReportQuantity? Quantity);

public sealed record MaterialItem(string Name, ReportQuantity? Quantity, bool? Delivered);

public sealed record BlockerItem(string Description, string? WaitingOn);

/// <summary>
/// The highest-value evidence in the product — the thing that cannot be proven once the wall is
/// closed (ARCHITECTURE §6) — which is why it gets its own block on the page rather than being
/// folded into work done.
/// </summary>
public sealed record HiddenWorkItem(string Description, IReadOnlyList<Guid> MediaIds);

public sealed record ReportHeadcount(int? Total, IReadOnlyList<ReportRole> Roles);

public sealed record ReportRole(string Role, int? Count);

/// <summary>A measured amount. Value and unit stay apart so the number is formatted in the
/// report's culture and the unit is left exactly as it was spoken (never translated).</summary>
public sealed record ReportQuantity(double? Value, string? Unit);

/// <summary>
/// One verified photograph, on disk. A file path rather than bytes on purpose: an entry may
/// carry twenty photos of up to 10 MB each, and holding a whole entry's evidence in memory per
/// worker is how a small VPS runs out of it. The bytes were hashed on the way to this file.
/// </summary>
public sealed record ReportPhoto(
    Guid MediaId,
    string FilePath,
    string Sha256,
    DateTimeOffset? CapturedAt);

/// <summary>
/// What makes the PDF evidence rather than a summary: when the phone captured it, when the server
/// took custody, and when the document itself was produced.
/// <para>
/// **No coordinates** (founder, 2026-08-29, PROJECT.md §11). <c>44.81731, 20.49829</c> is not
/// something an investor can act on; the site's address is. GPS is still captured on the entry and
/// still in the archive — it simply is not what this document prints.
/// </para>
/// <para>
/// <see cref="EntryId"/> stays on the record even though nothing prints it any more: the renderer
/// dropped the record-id line, but a report pass still logs and keys by entry, and the type that
/// describes an entry's provenance without naming the entry would be a puzzle to the next reader.
/// </para>
/// </summary>
public sealed record ReportProvenance(
    Guid EntryId,
    DateTimeOffset CapturedAt,
    DateTimeOffset? ReceivedAt,
    DateTimeOffset GeneratedAt);
