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

    /// <summary>
    /// Opens an object for reading, or returns null when there is nothing at that key.
    /// <para>
    /// The server's one read path, and it serves two very different callers on purpose. The
    /// pipeline downloads a voice note to transcribe it and verifies the SHA-256 the phone
    /// declared while it holds the bytes, because <c>/complete</c> verified size only
    /// (ARCHITECTURE §6). And <c>GET /api/entries/{id}/report</c> streams a stored report PDF
    /// back to the app.
    /// </para>
    /// <para>
    /// It returns <see cref="StoredObjectContent"/> rather than a bare stream so a caller that is
    /// answering an HTTP request can set <c>Content-Length</c> and <c>Content-Type</c> from what
    /// storage actually holds instead of guessing. **That is the shape the photo read path will
    /// need too** — closing the media-read gap in ARCHITECTURE §8 is a matter of adding an
    /// endpoint over this method, not of adding another one beside it.
    /// </para>
    /// <para>
    /// Because it moves whole files it uses the bulk client, not the phone-facing budget. The
    /// caller owns the returned content and must dispose it.
    /// </para>
    /// </summary>
    Task<StoredObjectContent?> OpenReadAsync(string objectKey, CancellationToken ct = default);

    /// <summary>
    /// Writes an object, overwriting whatever is at that key.
    /// <para>
    /// The one place the server *produces* bytes, and it exists for B6: a generated report is
    /// not media the phone uploaded, so there is no presigned PUT to hand anybody — the PDF is
    /// made here and must be stored from here. This does not weaken the §2 rule that media never
    /// passes through the API: media still does not. A report is our own artefact, and it is
    /// written from a Hangfire job, never from a request the phone is waiting on.
    /// </para>
    /// <para>
    /// Overwrite rather than create-if-absent is deliberate: the report object key is derived
    /// from the entry, so a re-run of a report pass that failed before delivery replaces its own
    /// half-finished output instead of leaving an orphan behind at a fresh key.
    /// </para>
    /// </summary>
    Task PutAsync(
        string objectKey, byte[] content, string contentType, CancellationToken ct = default);
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

/// <summary>
/// An open object: its bytes, and what storage says about them. Disposing it disposes the
/// underlying response.
/// </summary>
/// <param name="ByteSize">What storage reports, which is not the same thing as what the record
/// claims — the caller compares the two.</param>
/// <param name="ContentType">As declared when the object was written. Advisory: a caller serving
/// this to a browser should send the type it knows the object must be, not this one.</param>
public sealed record StoredObjectContent(
    Stream Content,
    long ByteSize,
    string? ContentType,
    string? ETag) : IDisposable
{
    public void Dispose() => Content.Dispose();
}
