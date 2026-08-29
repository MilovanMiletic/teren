namespace Teren.Core.Entities;

public enum MediaKind
{
    Audio,
    Photo,
}

public enum MediaUploadStatus
{
    Pending,
    Uploaded,
    Verified,
    Failed,
}

/// <summary>
/// One captured file (voice note or photo). The bytes live in object storage under
/// <see cref="ObjectKey"/>; this row is the evidence record: what was captured, when,
/// and its checksum. Raw media is never altered.
/// </summary>
public sealed class Media
{
    /// <summary>Generated on the phone, like the entry id.</summary>
    public Guid Id { get; set; }

    public Guid CompanyId { get; set; }
    public Guid EntryId { get; set; }
    public MediaKind Kind { get; set; }

    /// <summary>company/{companyId}/project/{projectId}/entry/{entryId}/{mediaId}.{ext} — no personal data in keys.</summary>
    public string ObjectKey { get; set; } = null!;

    public string ContentType { get; set; } = null!;
    public long ByteSize { get; set; }

    /// <summary>SHA-256 (hex) computed on the phone over the exact uploaded bytes; the server verifies it.</summary>
    public string Sha256 { get; set; } = null!;

    public DateTime? CapturedAt { get; set; }
    public MediaUploadStatus UploadStatus { get; set; }
    public DateTime CreatedAt { get; set; }
}
