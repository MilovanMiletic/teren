namespace Teren.Api.Contracts;

/// <summary>
/// The phone declaring the files it is about to upload. It does not send bytes here — it says
/// what the bytes are, and gets back permission to put them in exactly one place.
/// </summary>
public sealed record DeclareMediaRequest
{
    public IReadOnlyList<DeclaredMedia>? Files { get; init; }
}

public sealed record DeclaredMedia
{
    /// <summary>Generated on the phone, like the entry id; makes re-declaration idempotent.</summary>
    public Guid? Id { get; init; }

    /// <summary><c>audio</c> or <c>photo</c>.</summary>
    public string? Kind { get; init; }

    /// <summary>May carry parameters (<c>audio/ogg; codecs=opus</c>); the server normalises.</summary>
    public string? ContentType { get; init; }

    public long? ByteSize { get; init; }

    /// <summary>SHA-256 (64 hex chars) over the exact bytes about to be uploaded.</summary>
    public string? Sha256 { get; init; }

    public DateTimeOffset? CapturedAt { get; init; }
}

public sealed record DeclareMediaResponse(
    Guid EntryId,
    IReadOnlyList<MediaUploadTarget> Uploads);

/// <summary>
/// Where one file goes. <c>Url</c> is null when the object is already verified in storage —
/// verified evidence is never handed a second write permission.
/// </summary>
public sealed record MediaUploadTarget(
    Guid MediaId,
    string Kind,
    string ObjectKey,
    string UploadStatus,
    string? Url,
    string? Method,
    IReadOnlyDictionary<string, string>? RequiredHeaders,
    DateTimeOffset? ExpiresAt);

public sealed record MediaResponse(
    Guid Id,
    string Kind,
    string ContentType,
    long ByteSize,
    string Sha256,
    string ObjectKey,
    string UploadStatus,
    DateTimeOffset? CapturedAt,
    DateTimeOffset CreatedAt);
