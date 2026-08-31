using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Teren.Core.Storage;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Object storage stopped at the <see cref="IObjectStorage"/> seam — the interface exists for
/// exactly this. MinIO would add a container, a bucket lifecycle and real network timing to
/// tests whose subject is what the API does with storage's answer, not whether MinIO works.
/// <para>
/// It records every HEAD, which is how "a completed entry is not re-verified" is provable at
/// all: the assertion is that storage was never asked a second time.
/// </para>
/// <para>
/// From B4 it also holds real bytes, because the pipeline reads them and verifies their SHA-256.
/// An object put by size alone reads back as that many zero bytes — deterministic, and therefore
/// a checksum a test can compute — which is what makes the mismatch path provable without
/// contriving a corrupt file.
/// </para>
/// </summary>
public sealed class FakeObjectStorage : IObjectStorage
{
    private readonly ConcurrentDictionary<string, byte[]> _objects = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _headCalls = new();
    private readonly ConcurrentQueue<string> _readCalls = new();
    private readonly ConcurrentQueue<string> _putCalls = new();
    private readonly ConcurrentDictionary<string, string> _contentTypes = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, StrongBox<long>> _bytesRead =
        new(StringComparer.Ordinal);

    /// <summary>Keys whose HEAD or read throws as if the store were unreachable.</summary>
    public HashSet<string> UnreachableKeys { get; } = new(StringComparer.Ordinal);

    /// <summary>When set, every call throws — the whole store is down.</summary>
    public bool Unreachable { get; set; }

    /// <summary>Delay applied to every HEAD, for exercising the verification budget.</summary>
    public TimeSpan HeadDelay { get; set; } = TimeSpan.Zero;

    /// <summary>Delay applied to every read, for exercising Reporting:RenderBudget — storage that
    /// answers slowly rather than not at all is precisely the failure that budget exists for.</summary>
    public TimeSpan ReadDelay { get; set; } = TimeSpan.Zero;

    public IReadOnlyList<string> HeadCalls => [.. _headCalls];

    public int HeadCallCount => _headCalls.Count;

    public int ReadCallCount => _readCalls.Count;

    /// <summary>Every object key that was opened for reading, in order — which is how "the key
    /// came from the database row and not from the request path" is assertable.</summary>
    public IReadOnlyList<string> ReadCalls => [.. _readCalls];

    /// <summary>
    /// How many bytes a caller actually pulled off the stream for a key, across all reads.
    /// <para>
    /// It exists for one assertion that nothing else can make: a reader that bounds its copy by
    /// the size the database declared <em>stops early</em> on an object that is bigger than that,
    /// and a reader that does not, does not. The status code is identical either way — the
    /// checksum refuses the bytes in both cases — so without counting the bytes, dropping the
    /// bound is a mutation no test in this suite would see.
    /// </para>
    /// </summary>
    public long BytesReadFor(string objectKey) =>
        _bytesRead.TryGetValue(objectKey, out var count) ? Interlocked.Read(ref count.Value) : 0;

    /// <summary>Pretend the phone finished a PUT: the object exists with this many bytes.</summary>
    public void PutObject(string objectKey, long byteSize) =>
        _objects[objectKey] = new byte[byteSize];

    /// <summary>Pretend the phone uploaded exactly these bytes.</summary>
    public void PutObject(string objectKey, byte[] content) => _objects[objectKey] = content;

    public void RemoveObject(string objectKey) => _objects.TryRemove(objectKey, out _);

    public void Reset()
    {
        _objects.Clear();
        _headCalls.Clear();
        _readCalls.Clear();
        _putCalls.Clear();
        _contentTypes.Clear();
        _bytesRead.Clear();
        UnreachableKeys.Clear();
        Unreachable = false;
        HeadDelay = TimeSpan.Zero;
        ReadDelay = TimeSpan.Zero;
    }

    public ValueTask<PresignedUpload> CreatePresignedUploadAsync(
        string objectKey, string contentType, TimeSpan ttl, CancellationToken ct = default)
    {
        // Signing is a local HMAC in the real adapter too — no network, so nothing to fake but
        // the shape of the answer.
        var upload = new PresignedUpload(
            $"https://storage.test/teren-media/{objectKey}?X-Amz-Expires={(int)ttl.TotalSeconds}",
            "PUT",
            DateTimeOffset.UtcNow.Add(ttl),
            new Dictionary<string, string> { ["Content-Type"] = contentType });

        return ValueTask.FromResult(upload);
    }

    public async Task<StoredObject?> HeadAsync(string objectKey, CancellationToken ct = default)
    {
        _headCalls.Enqueue(objectKey);

        if (HeadDelay > TimeSpan.Zero)
        {
            await Task.Delay(HeadDelay, ct);
        }

        ThrowIfUnreachable(objectKey);

        return _objects.TryGetValue(objectKey, out var content)
            ? new StoredObject(content.LongLength, "\"etag\"", DateTimeOffset.UtcNow)
            : null;
    }

    public async Task<StoredObjectContent?> OpenReadAsync(
        string objectKey, CancellationToken ct = default)
    {
        _readCalls.Enqueue(objectKey);

        if (ReadDelay > TimeSpan.Zero)
        {
            await Task.Delay(ReadDelay, ct);
        }

        ThrowIfUnreachable(objectKey);

        return _objects.TryGetValue(objectKey, out var content)
            ? new StoredObjectContent(
                new CountingStream(
                    new MemoryStream(content, writable: false),
                    _bytesRead.GetOrAdd(objectKey, _ => new StrongBox<long>(0))),
                content.LongLength,
                _contentTypes.TryGetValue(objectKey, out var type) ? type : null,
                "\"etag\"")
            : null;
    }

    /// <summary>
    /// The write side, added at B6: a generated report PDF is the one artefact the server
    /// produces rather than receives. Recorded per key so "the PDF was stored, once, at the key
    /// derived from the entry" is assertable, and so a retry overwriting its own output is
    /// visible rather than assumed.
    /// </summary>
    public Task PutAsync(
        string objectKey, byte[] content, string contentType, CancellationToken ct = default)
    {
        _putCalls.Enqueue(objectKey);
        ThrowIfUnreachable(objectKey);
        _objects[objectKey] = content;
        _contentTypes[objectKey] = contentType;
        return Task.CompletedTask;
    }

    public IReadOnlyList<string> PutCalls => [.. _putCalls];

    public byte[]? GetObject(string objectKey) =>
        _objects.TryGetValue(objectKey, out var content) ? content : null;

    public string? ContentTypeOf(string objectKey) =>
        _contentTypes.TryGetValue(objectKey, out var type) ? type : null;

    /// <summary>A read-only pass-through that tallies what was actually pulled off it. Small
    /// enough to keep here: the only thing it is for is the byte tally above.</summary>
    private sealed class CountingStream(Stream inner, StrongBox<long> tally) : Stream
    {
        public override bool CanRead => inner.CanRead;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => inner.Length;

        public override long Position
        {
            get => inner.Position;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = inner.Read(buffer, offset, count);
            Interlocked.Add(ref tally.Value, read);
            return read;
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer, CancellationToken ct = default)
        {
            var read = await inner.ReadAsync(buffer, ct);
            Interlocked.Add(ref tally.Value, read);
            return read;
        }

        public override void Flush() => inner.Flush();

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
            }

            base.Dispose(disposing);
        }
    }

    private void ThrowIfUnreachable(string objectKey)
    {
        if (Unreachable || UnreachableKeys.Contains(objectKey))
        {
            throw new ObjectStorageUnavailableException(
                $"Test storage is unreachable for {objectKey}.");
        }
    }
}
