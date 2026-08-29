using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using Teren.Core.Entities;
using Teren.Core.Storage;

namespace Teren.Infrastructure.Storage;

/// <summary>What is wrong with the stored bytes, as a kind rather than a sentence.</summary>
public enum EvidenceIntegrityKind
{
    /// <summary>The object was verified at <c>/complete</c> and is not in storage now.</summary>
    Missing,

    /// <summary>The bytes are not the bytes the phone hashed — wrong length, or a different
    /// SHA-256.</summary>
    ChecksumMismatch,
}

/// <summary>
/// The stored bytes are not the evidence the record claims. Always terminal: no number of reads
/// turns the wrong bytes into the right ones.
/// <para>
/// <see cref="Kind"/>, not the message, is what callers branch on. Each caller maps it to its
/// own <c>failure_reason</c> vocabulary — the pipeline says <c>audio_*</c>, the report pass says
/// <c>photo_*</c> — because a foreman needs to be told which of his files is the problem.
/// </para>
/// </summary>
public sealed class EvidenceIntegrityException(EvidenceIntegrityKind kind, string message)
    : Exception(message)
{
    public EvidenceIntegrityKind Kind { get; } = kind;
}

/// <summary>
/// Reads a media object and proves it is what the phone said it was, before anything downstream
/// treats it as evidence.
/// <para>
/// **This is the obligation B3 handed forward** (ARCHITECTURE §6, review F3): <c>/complete</c>
/// verifies existence and byte size only, because the API never reads media bytes. The first
/// moment anyone reads them is the first moment the checksum can be checked — the pipeline when
/// it transcribes the voice note, and report generation when it embeds a photograph. One
/// implementation for both, so the promise cannot hold in one place and quietly lapse in the
/// other.
/// </para>
/// </summary>
public static class VerifiedMediaReader
{
    private const int ChunkSize = 81920;

    /// <summary>Whole-file read, for a voice note that is about to be posted to a transcription
    /// service and must therefore exist in memory anyway.</summary>
    public static async Task<byte[]> ReadAsync(
        IObjectStorage storage, Media media, ILogger logger, CancellationToken ct)
    {
        using var buffer = new MemoryStream(
            capacity: (int)Math.Min(media.ByteSize, 1 << 20));

        await CopyVerifiedAsync(storage, media, buffer, logger, ct);
        return buffer.ToArray();
    }

    /// <summary>
    /// Streams the object to a file, for a photograph the renderer will read back from disk.
    /// <para>
    /// A file rather than a byte array because an entry may carry twenty photographs of up to
    /// 10 MB each: holding a whole evidence set per worker is how a small VPS runs out of
    /// memory, and the renderer wants a path anyway.
    /// </para>
    /// </summary>
    public static async Task ReadToFileAsync(
        IObjectStorage storage,
        Media media,
        string destinationPath,
        ILogger logger,
        CancellationToken ct)
    {
        await using var file = new FileStream(
            destinationPath,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            ChunkSize,
            useAsync: true);

        await CopyVerifiedAsync(storage, media, file, logger, ct);
    }

    /// <summary>
    /// Copies storage to <paramref name="destination"/>, hashing as it goes and refusing
    /// anything that is not exactly what was declared.
    /// </summary>
    private static async Task CopyVerifiedAsync(
        IObjectStorage storage,
        Media media,
        Stream destination,
        ILogger logger,
        CancellationToken ct)
    {
        using var stored = await storage.OpenReadAsync(media.ObjectKey, ct);
        if (stored is null)
        {
            throw new EvidenceIntegrityException(
                EvidenceIntegrityKind.Missing,
                $"media {media.Id} is no longer in storage, though it was verified when the "
                + "entry was completed");
        }

        var source = stored.Content;

        // Bounded by the declared size plus a byte: anything larger is not the file that was
        // declared, and copying it would be an unbounded write driven by storage content.
        var limit = media.ByteSize + 1;
        var chunk = new byte[ChunkSize];
        long total = 0;

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        while (true)
        {
            var read = await source.ReadAsync(chunk, ct);
            if (read == 0)
            {
                break;
            }

            total += read;
            if (total > limit)
            {
                throw new EvidenceIntegrityException(
                    EvidenceIntegrityKind.ChecksumMismatch,
                    $"the stored object is larger than the {media.ByteSize} bytes declared for "
                    + $"media {media.Id}");
            }

            hash.AppendData(chunk, 0, read);
            await destination.WriteAsync(chunk.AsMemory(0, read), ct);
        }

        await destination.FlushAsync(ct);

        if (total != media.ByteSize)
        {
            throw new EvidenceIntegrityException(
                EvidenceIntegrityKind.ChecksumMismatch,
                $"the stored object is {total} bytes but media {media.Id} declared "
                + $"{media.ByteSize}");
        }

        var actual = Convert.ToHexStringLower(hash.GetHashAndReset());
        var declared = media.Sha256.TrimEnd();

        if (!string.Equals(actual, declared, StringComparison.OrdinalIgnoreCase))
        {
            // Never silent (ARCHITECTURE §6). The bytes in storage are not the bytes the phone
            // hashed, so nothing downstream may treat them as this entry's evidence — not the
            // transcript it would produce, and above all not a photograph in a PDF a client
            // will rely on in a dispute.
            throw new EvidenceIntegrityException(
                EvidenceIntegrityKind.ChecksumMismatch,
                $"media {media.Id} hashes to {actual} but was declared as {declared}");
        }

        logger.LogInformation(
            "Entry {EntryId}: media {MediaId} verified ({Bytes} bytes, sha256 matches).",
            media.EntryId, media.Id, total);
    }
}
