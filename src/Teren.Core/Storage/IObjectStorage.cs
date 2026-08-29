namespace Teren.Core.Storage;

/// <summary>
/// What the object store must do for us. Deliberately tiny: the API never touches media bytes
/// (ARCHITECTURE §2 rule 1) — it hands out a narrow permission to upload, and later asks whether
/// the object arrived.
/// </summary>
public interface IObjectStorage
{
    /// <summary>
    /// Mints a presigned URL that permits exactly one PUT of exactly one object key, expiring
    /// after <paramref name="ttl"/>. No listing, no wildcards, no other verb.
    /// <para>
    /// This is a local HMAC over the request description — no network call — so it is safe to do
    /// inside a request from the phone (PROJECT.md principle 4). The signature is async only
    /// because credential resolution in the AWS SDK is.
    /// </para>
    /// </summary>
    ValueTask<PresignedUpload> CreatePresignedUploadAsync(
        string objectKey, string contentType, TimeSpan ttl, CancellationToken ct = default);

    /// <summary>
    /// Metadata for an object, or null when it does not exist. Storage-bound (a HEAD request):
    /// only call it where an extra round trip is acceptable.
    /// </summary>
    Task<StoredObject?> HeadAsync(string objectKey, CancellationToken ct = default);
}

/// <summary>
/// A one-object upload permission. <paramref name="RequiredHeaders"/> are signed into the URL —
/// the client must send them verbatim or storage rejects the PUT.
/// </summary>
public sealed record PresignedUpload(
    string Url,
    string Method,
    DateTimeOffset ExpiresAt,
    IReadOnlyDictionary<string, string> RequiredHeaders);

public sealed record StoredObject(long ByteSize, string? ETag, DateTimeOffset LastModified);
