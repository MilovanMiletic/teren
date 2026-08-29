using System.Security.Cryptography;
using Teren.Core.Storage;

namespace Teren.Infrastructure.Storage;

/// <summary>
/// A stored object, fetched and proven to be the bytes the database says it is, ready to be
/// handed to an HTTP response.
/// <para>
/// Sibling of <see cref="VerifiedMediaReader"/> and the same promise pointed outwards: that one
/// verifies bytes on the way *into* a transcript or a PDF, this one verifies them on the way
/// *out* to a person. Separate because it knows nothing about the <c>media</c> table — it takes a
/// key and an expected hash — which is exactly what lets the photo read path (ARCHITECTURE §8's
/// open gap) use it unchanged.
/// </para>
/// </summary>
public static class VerifiedObjectReader
{
    private const int ChunkSize = 81920;

    /// <summary>
    /// Streams an object to a temporary file, hashing as it goes, and returns it open for reading
    /// — or null when there is nothing at that key.
    /// <para>
    /// **Via a file rather than memory, and verified before a byte is served.** Two constraints
    /// meet here. A report may be megabytes and one per concurrent request must not sit on a
    /// small VPS's heap, so it does not go through a <c>MemoryStream</c>. And a hash cannot be
    /// checked until the last byte has been read, so streaming storage straight to the client
    /// would mean discovering a mismatch after the client already had most of the file — the
    /// caller could only cut the connection and hope. Spooling to disk first costs a write and
    /// buys a verdict *before* anything is sent, which is the same order of operations that makes
    /// photo verification meaningful (ARCHITECTURE §6, review F3).
    /// </para>
    /// <para>
    /// The returned stream is opened <see cref="FileOptions.DeleteOnClose"/>: the file is unlinked
    /// when the response finishes writing it, including when the request is abandoned half way,
    /// so an interrupted download cannot leave litter in the temp directory.
    /// </para>
    /// </summary>
    /// <param name="expectedSha256">The hash the database recorded, or null when the row predates
    /// the column — in which case the bytes are served unverified and the caller says so.</param>
    /// <exception cref="EvidenceIntegrityException">The stored bytes are not the recorded
    /// bytes.</exception>
    public static async Task<VerifiedObject?> OpenVerifiedAsync(
        IObjectStorage storage,
        string objectKey,
        string? expectedSha256,
        CancellationToken ct)
    {
        using var stored = await storage.OpenReadAsync(objectKey, ct);
        if (stored is null)
        {
            return null;
        }

        var path = Path.Combine(Path.GetTempPath(), $"teren-download-{Guid.NewGuid():N}.tmp");

        FileStream file = new(
            path,
            FileMode.CreateNew,
            FileAccess.ReadWrite,
            FileShare.None,
            ChunkSize,
            FileOptions.Asynchronous | FileOptions.DeleteOnClose);

        try
        {
            var chunk = new byte[ChunkSize];
            long total = 0;

            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

            while (true)
            {
                var read = await stored.Content.ReadAsync(chunk, ct);
                if (read == 0)
                {
                    break;
                }

                total += read;
                hash.AppendData(chunk, 0, read);
                await file.WriteAsync(chunk.AsMemory(0, read), ct);
            }

            await file.FlushAsync(ct);

            var actual = Convert.ToHexStringLower(hash.GetHashAndReset());

            if (expectedSha256 is { Length: > 0 }
                && !string.Equals(
                    actual, expectedSha256.TrimEnd(), StringComparison.OrdinalIgnoreCase))
            {
                // The object store holds something other than what was sent. Nobody gets these
                // bytes: handing back a document that does not match the record, on a product
                // whose whole claim is that the record is trustworthy, is worse than handing back
                // nothing at all.
                throw new EvidenceIntegrityException(
                    EvidenceIntegrityKind.ChecksumMismatch,
                    $"the object at {objectKey} hashes to {actual} but was recorded as "
                    + expectedSha256.TrimEnd());
            }

            file.Position = 0;
            return new VerifiedObject(
                file, total, actual, Verified: expectedSha256 is { Length: > 0 });
        }
        catch
        {
            // DeleteOnClose means disposing is also cleaning up.
            await file.DisposeAsync();
            throw;
        }
    }
}

/// <summary>
/// Bytes on disk that have been checked against the record, open and rewound.
/// <para>
/// Disposable because it owns a temp file: serving it through <c>Results.File</c> hands that
/// ownership to the framework, which disposes the stream when the response is written, but a
/// caller that decides <em>not</em> to serve it must still be able to let go of the file. It is
/// unlinked on close either way.
/// </para>
/// </summary>
/// <param name="Verified">False when the row carried no hash to check against — the bytes are
/// served, and the caller logs that nothing proved them.</param>
public sealed record VerifiedObject(
    Stream Content,
    long ByteSize,
    string Sha256,
    bool Verified) : IDisposable
{
    public void Dispose() => Content.Dispose();
}
