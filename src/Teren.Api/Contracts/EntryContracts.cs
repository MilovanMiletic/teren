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
