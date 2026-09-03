using System.Text.Json.Nodes;

namespace Teren.Api.Contracts;

/// <summary>
/// What the phone declares when it hands an entry over. Every field is nullable so that a
/// missing one becomes a validation message naming it, rather than a deserialisation failure.
/// </summary>
public sealed record CreateEntryRequest
{
    /// <summary>Generated on the phone. This is the idempotency key — replaying it is free.</summary>
    public Guid? Id { get; init; }

    public Guid? ProjectId { get; init; }

    /// <summary>The site day this entry is about (not the upload day).</summary>
    public DateOnly? EntryDate { get; init; }

    /// <summary>When the phone captured it (client clock). Defaults to server time if absent.</summary>
    public DateTimeOffset? CreatedAt { get; init; }

    public double? Latitude { get; init; }
    public double? Longitude { get; init; }
    public double? GpsAccuracyM { get; init; }

    /// <summary>
    /// The entry this one corrects (PROJECT.md §5 invariant 2, ARCHITECTURE §6).
    ///
    /// <para>
    /// <b>It exists because the field was on the entity and on <see cref="EntryResponse"/> and
    /// not here</b>, so <c>System.Text.Json</c> dropped it in silence: a "Napravi ispravku"
    /// button would have written an entry that <em>claimed</em> to be a correction and linked to
    /// nothing. A correction that cannot name what it corrects is weaker evidence than the
    /// notebook this product replaces.
    /// </para>
    ///
    /// <para>
    /// <b>The target may be in any state, and that is a decision rather than an omission.</b>
    /// Invariant 2 says corrections are new entries because a <em>reported</em> entry is
    /// immutable, so the obvious rule would be "the target must be reported". It is refused for
    /// three reasons. First, the product already produces the counter-example: an entry left
    /// <c>confirmed</c> with <c>superseded_after_send</c> has had a report delivered and can never
    /// get another (<c>ux_report_entry_id</c>, and there is no <c>sent → sending</c>), and
    /// ARCHITECTURE §6 names a new entry with this field as its only answer — a reported-only rule
    /// would forbid the one correction the server itself asks for. Second, the phone's failure
    /// taxonomy makes a 4xx <b>terminal</b>: a rejected POST does not bounce, it abandons a day of
    /// captured work in an outbox, and no state check is worth that. Third, whether yesterday is
    /// best fixed in place or superseded is a bookkeeping judgement a foreman makes and the server
    /// cannot adjudicate; refusing his link would not stop him writing the entry, only stop it
    /// saying what it is for.
    /// </para>
    ///
    /// <para>
    /// <b>Chains are allowed</b> — a correction of a correction — because a correction can itself
    /// be wrong, and forcing every link back to the head of the chain would destroy the order in
    /// which a day was revised. They cannot cycle: the target has to exist before the entry that
    /// names it, so the links follow creation order and no back edge can ever be written.
    /// <c>DemoResetCommand</c> already peels entries leaf-first for exactly this reason.
    /// </para>
    ///
    /// <para>
    /// What <em>is</em> checked, in the handler and not here, is that the target is an entry of
    /// <b>this caller's company and of the same site</b> — otherwise a correction could link to
    /// another tenant's row and <see cref="EntryResponse.SupersedesEntryId"/> would hand one
    /// company an id belonging to another. Anything else answers 404, exactly as a project that
    /// is not the caller's does (ARCHITECTURE §7).
    /// </para>
    /// </summary>
    public Guid? SupersedesEntryId { get; init; }

    // There is deliberately no DeviceId here any more (D2, profile-and-identity §8). It used to
    // be an "optional override of the device provenance derived from the token", which made sense
    // while one static token stood for the whole company and no device rows existed. With real
    // devices it is a provenance lie on an evidence row: the phone would be telling the server
    // which phone recorded a day's work, and the report would say so.
    //
    // The field is ACCEPTED AND IGNORED rather than rejected — System.Text.Json drops unmapped
    // members by default, and nothing in this API sets UnmappedMemberHandling.Disallow. That is
    // the deliberate choice: a 400 would break any phone in the field still sending it, and the
    // whole point of an outbox is that a captured day eventually gets through. The shipped PWA
    // does not send it (web/.../core/api/api-types.ts), so today this removes a hazard that
    // nothing was using.
}

/// <summary>
/// The server's view of one entry: the poll target, and the response to every write on the
/// upload path so a client always leaves a call knowing exactly where the entry stands.
/// </summary>
public sealed record EntryResponse(
    Guid Id,
    Guid ProjectId,
    DateOnly EntryDate,
    string Status,
    DateTimeOffset CreatedAt,
    // ReceivedAt is stamped when the server holds the complete entry — JSON plus every declared
    // object verified in storage. Null means uploads are still outstanding.
    DateTimeOffset? ReceivedAt,
    DateTimeOffset? ConfirmedAt,
    DateTimeOffset? ReportedAt,
    string? FailureReason,
    // The transcript, in the language it was spoken and transliterated to Latin at ingestion.
    // The confirmation screen cannot exist without it — a human approving what the system
    // understood has to be able to read what it heard — and on a needs_review entry it is often
    // the only thing the pipeline produced.
    string? RawTranscript,
    double? Latitude,
    double? Longitude,
    double? GpsAccuracyM,
    Guid? DeviceId,
    Guid? SupersedesEntryId,
    // Structure/Corrected/Weather are raw JSONB, passed through untouched — the server never
    // reshapes evidence on its way out.
    JsonNode? Structure,
    JsonNode? Corrected,
    JsonNode? Weather,
    IReadOnlyList<MediaResponse> Media);

/// <summary>
/// One row of the archive list. Detail (structure, transcript) needs the item endpoint.
/// <para>
/// <b><see cref="FailureReason"/> and <see cref="SupersedesEntryId"/> are on the row and not only
/// on the item, and both earn their place by removing a wasted tap.</b> Without the reason, the
/// list cannot tell a day that is merely waiting from a day that is stuck, so it offers "Ispravi"
/// on both and one of the taps lands on a gate that says no. Without the link, a corrected day
/// and the correction itself are indistinguishable rows: a client holding a page of these can
/// build the set of superseded ids from it and mark both ends, which is the only way an archive
/// can stop showing a superseded day as if it were still the record. Neither field exposes a new
/// class of data — both are already on <see cref="EntryResponse"/>, under the same tenant filter.
/// </para>
/// <para>
/// The superseded set a client derives is complete only over the rows it holds, which is a real
/// limit worth stating: a correction written on a page the client has not fetched leaves the older
/// day unmarked until it does. It is the archive's existing merge, not a new mechanism.
/// </para>
/// </summary>
public sealed record EntryListItemResponse(
    Guid Id,
    Guid ProjectId,
    DateOnly EntryDate,
    string Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReceivedAt,
    DateTimeOffset? ReportedAt,
    /// <summary><c>"{code}: {detail}"</c>, as stored. The client branches on the code and never on
    /// the English prose (CLAUDE.md's failure taxonomy).</summary>
    string? FailureReason,
    /// <summary>Set on a correction: the entry of this same site that this one supersedes.</summary>
    Guid? SupersedesEntryId,
    int PhotoCount,
    bool HasAudio);

public sealed record EntryListResponse(IReadOnlyList<EntryListItemResponse> Entries, int Count);

/// <summary>
/// The answer to "I have finished uploading". <c>Ready</c> means the entry is complete evidence
/// and the processing pipeline may take it; anything listed in <c>PendingMedia</c> or
/// <c>FailedMedia</c> is the client's cue to re-request a URL and try again.
/// </summary>
public sealed record CompleteEntryResponse(
    bool Ready,
    string? Reason,
    IReadOnlyList<Guid> PendingMedia,
    IReadOnlyList<Guid> FailedMedia,
    EntryResponse Entry);

/// <summary>
/// What the human approved on the confirmation screen (ARCHITECTURE §7).
/// <para>
/// Only <c>corrected</c> is accepted, and that is the point: <c>raw_transcript</c> is evidence
/// and write-once, <c>structure</c> is what the model said and must stay exactly that, and
/// <c>corrected</c> is what the person signed off. The three together are the eval set (§9.3),
/// so no request is ever allowed to make one of them overwrite another.
/// </para>
/// </summary>
public sealed record ConfirmEntryRequest
{
    /// <summary>The approved v1 entry structure. Must carry <c>schema_version</c>.</summary>
    public JsonNode? Corrected { get; init; }
}
