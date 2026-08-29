namespace Teren.Core.Entities;

/// <summary>
/// What the server is willing to accept as evidence media, and what it will call the object in
/// storage. Lives in Core because it is a product rule, not a transport detail: the same limits
/// decide whether a declaration is valid and what extension the object key gets.
/// </summary>
public static class MediaPolicy
{
    /// <summary>One ~30 s Opus voice note is ~100 KB; 25 MB is a generous ceiling that still
    /// stops a runaway recording or a mis-typed declaration from reserving unbounded storage.</summary>
    public const long MaxAudioBytes = 25L * 1024 * 1024;

    /// <summary>Photos are compressed client-side to 1600 px / JPEG ~80 (~300 KB). 10 MB covers
    /// an uncompressed fallback without inviting raw 50 MP originals.</summary>
    public const long MaxPhotoBytes = 10L * 1024 * 1024;

    public const int MaxPhotosPerEntry = 20;

    /// <summary>
    /// One entry, one voice note. This is not an arbitrary quota: the pipeline transcribes *the*
    /// recording, and the report is built from it — two audio files on one entry leaves B4 with
    /// no way to say which one is the foreman's account of the day. Re-declaring the same media
    /// id stays free, because that is how a client retries an upload.
    /// </summary>
    public const int MaxAudioPerEntry = 1;

    /// <summary>
    /// The hard ceiling on one entry's evidence set, and therefore on the work
    /// <c>/complete</c> does: the verification loop is bounded by this number of HEAD requests.
    /// </summary>
    public const int MaxMediaPerEntry = MaxPhotosPerEntry + MaxAudioPerEntry;

    public static int MaxPerEntry(MediaKind kind) =>
        kind == MediaKind.Audio ? MaxAudioPerEntry : MaxPhotosPerEntry;

    /// <summary>
    /// Accepted content types per kind, mapped to the object-key extension.
    /// Audio carries several containers on purpose: MediaRecorder yields OGG/Opus on Android and
    /// MP4/AAC on iOS Safari (ARCHITECTURE §5, open decision 4) — the server normalises later
    /// rather than rejecting a foreman's only recording.
    /// </summary>
    private static readonly Dictionary<string, string> AudioTypes = new(StringComparer.Ordinal)
    {
        ["audio/ogg"] = "ogg",
        ["audio/opus"] = "opus",
        ["audio/webm"] = "webm",
        ["audio/mp4"] = "m4a",
        ["audio/aac"] = "aac",
        ["audio/mpeg"] = "mp3",
        ["audio/wav"] = "wav",
        ["audio/x-wav"] = "wav",
    };

    private static readonly Dictionary<string, string> PhotoTypes = new(StringComparer.Ordinal)
    {
        ["image/jpeg"] = "jpg",
        ["image/png"] = "png",
        ["image/webp"] = "webp",
    };

    public static long MaxBytesFor(MediaKind kind) =>
        kind == MediaKind.Audio ? MaxAudioBytes : MaxPhotoBytes;

    public static IReadOnlyCollection<string> AcceptedContentTypes(MediaKind kind) =>
        kind == MediaKind.Audio ? AudioTypes.Keys : PhotoTypes.Keys;

    /// <summary>
    /// Normalises a client-declared content type (MediaRecorder reports parameters, e.g.
    /// <c>audio/ogg; codecs=opus</c>) and resolves the object-key extension. Returns false when
    /// the type is not accepted for the kind.
    /// </summary>
    public static bool TryResolveContentType(
        MediaKind kind, string? declared, out string contentType, out string extension)
    {
        contentType = string.Empty;
        extension = string.Empty;

        if (string.IsNullOrWhiteSpace(declared))
        {
            return false;
        }

        // "audio/ogg; codecs=opus" → "audio/ogg". The parameters are the client's business;
        // the stored content type is the media type the object is served with.
        var separator = declared.IndexOf(';');
        var normalised = (separator >= 0 ? declared[..separator] : declared)
            .Trim()
            .ToLowerInvariant();

        var table = kind == MediaKind.Audio ? AudioTypes : PhotoTypes;
        if (!table.TryGetValue(normalised, out var ext))
        {
            return false;
        }

        contentType = normalised;
        extension = ext;
        return true;
    }

    /// <summary>SHA-256 as 64 lowercase hex characters, or false if it is not that.</summary>
    public static bool TryNormaliseSha256(string? declared, out string sha256)
    {
        sha256 = string.Empty;
        if (declared is not { Length: 64 })
        {
            return false;
        }

        foreach (var c in declared)
        {
            var isHex = c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F';
            if (!isHex)
            {
                return false;
            }
        }

        sha256 = declared.ToLowerInvariant();
        return true;
    }
}
