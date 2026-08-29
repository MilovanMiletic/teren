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

    /// <summary>Optional override of the device provenance derived from the token.</summary>
    public Guid? DeviceId { get; init; }
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

/// <summary>One row of the archive list. Detail (structure, transcript) needs the item endpoint.</summary>
public sealed record EntryListItemResponse(
    Guid Id,
    Guid ProjectId,
    DateOnly EntryDate,
    string Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReceivedAt,
    DateTimeOffset? ReportedAt,
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
