using Teren.Core.Entities;

namespace Teren.Core.Platform;

/// <summary>
/// The <b>only</b> shape in which the platform code path can read the evidence tables, and the
/// type is the allow-list.
///
/// <para>
/// The health page has to answer "what is failing, and whose" (plan §8, decision 12), and that
/// question cannot be answered without reading <c>entry</c> and <c>report</c>. Layer 3 of the
/// privacy claim (plan §6) says the platform path is compiled against a model with no
/// <c>Entry</c>, <c>Media</c> or <c>Report</c> in it, and it still is: <c>db.Set&lt;Entry&gt;()</c>
/// on <c>TerenIdentityDbContext</c> throws exactly as before. What is mapped instead is this —
/// four columns, none of which is content.
/// </para>
///
/// <para>
/// <b>Why a hand-written type rather than a wider mapping of the real entity.</b> EF maps every
/// scalar property a keyless type <em>has</em>, so the class declaration is the enumerated column
/// list: there is no <c>raw_transcript</c> property to select, no <c>structure</c>, no
/// <c>corrected</c>, no object key. Adding one would be a diff to this file, in a directory named
/// for the platform, and <c>IdentityModelTests</c> pins the mapped columns so the diff cannot be
/// a quiet one. An <c>Ignore()</c> list on <see cref="Entry"/> would have inverted that — every
/// new evidence column would arrive on the platform surface by default.
/// </para>
///
/// <para>
/// <b>The narrowed claim, said in full</b> (plan §6, founder 2026-08-30): Teren staff can see
/// which companies and sites exist and what is failing. They cannot read a transcript, view a
/// photograph, or open a report. Nothing here weakens the second sentence; it is what makes the
/// first one true.
/// </para>
///
/// <para>
/// <b>Nothing reads these rows one at a time.</b> Every query over them is a grouped aggregate
/// (<c>PlatformDirectory.HealthAsync</c>), so Postgres does the counting and what crosses the
/// wire is buckets. That is a property of the caller rather than of the mapping, which is why the
/// mapping is kept as narrow as it is.
/// </para>
/// </summary>
public sealed class EntryHealthRow
{
    public Guid CompanyId { get; set; }

    /// <summary>Which site, so a count can be attributed to one. The <em>name</em> comes from
    /// <see cref="Project"/>; nothing else about a project is on this surface.</summary>
    public Guid ProjectId { get; set; }

    public EntryStatus Status { get; set; }

    /// <summary>
    /// As stored: <c>"{code}: {detail}"</c>. <b>The detail never leaves the server.</b> The
    /// aggregate folds this to its code half and then admits only codes declared in
    /// <c>ProcessingFailure</c>, because a detail is written by the pipeline and can carry an
    /// external provider's own words — the same reason <c>AiProviderException</c> is off the log
    /// sink's exception allow-list (ARCHITECTURE §12).
    /// </summary>
    public string? FailureReason { get; set; }
}

/// <summary>
/// The delivery half of <see cref="EntryHealthRow"/>: how many reports are in flight, went out, or
/// failed, per site, and why. Same four columns, same rule — no <c>pdf_object_key</c>, no
/// <c>recipients</c>, no <c>delivery_detail</c> (that one is the relay's own sentence about a
/// named inbox, which is a recipient address by another route).
/// </summary>
public sealed class ReportHealthRow
{
    public Guid CompanyId { get; set; }

    public Guid ProjectId { get; set; }

    public ReportStatus Status { get; set; }

    /// <inheritdoc cref="EntryHealthRow.FailureReason"/>
    public string? FailureReason { get; set; }
}
