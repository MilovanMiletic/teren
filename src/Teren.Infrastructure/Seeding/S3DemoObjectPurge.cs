using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Storage;
using Teren.Infrastructure.Storage;

namespace Teren.Infrastructure.Seeding;

/// <summary>
/// <see cref="IDemoObjectPurge"/> against the real S3-compatible store — MinIO locally, Hetzner
/// Object Storage on a demo host. Its own client, because the shared
/// <see cref="S3ObjectStorage"/> budgets are tuned for a phone-facing request and a sweep of a
/// few hundred objects is neither urgent nor allowed to give up after five seconds.
/// </summary>
public sealed class S3DemoObjectPurge : IDemoObjectPurge, IDisposable
{
    /// <summary>The S3 API's own limit on one DeleteObjects request.</summary>
    private const int DeleteBatchSize = 1000;

    private readonly AmazonS3Client _client;
    private readonly StorageOptions _options;
    private readonly ILogger<S3DemoObjectPurge> _logger;

    public S3DemoObjectPurge(IOptions<StorageOptions> options, ILogger<S3DemoObjectPurge> logger)
    {
        _options = options.Value;
        _logger = logger;

        _client = new AmazonS3Client(
            new BasicAWSCredentials(_options.AccessKey, _options.SecretKey),
            new AmazonS3Config
            {
                ServiceURL = _options.Endpoint,
                UseHttp = _options.Endpoint.StartsWith("http://", StringComparison.OrdinalIgnoreCase),
                ForcePathStyle = _options.ForcePathStyle,
                AuthenticationRegion = _options.Region,
                // A maintenance command run by a person at a terminal: it may wait, and it may
                // retry. This is the one place in the codebase where the SDK's own retries are
                // welcome, because nothing here writes a failure_reason anyone will read and
                // there is no pipeline budget for a slow sweep to outrun (ARCHITECTURE §10).
                Timeout = TimeSpan.FromSeconds(30),
                MaxErrorRetry = 3,
            });
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<string>> ListAsync(
        string prefix, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(prefix);

        var keys = new List<string>();
        string? continuationToken = null;

        do
        {
            var page = await _client.ListObjectsV2Async(
                new ListObjectsV2Request
                {
                    BucketName = _options.Bucket,
                    Prefix = prefix,
                    ContinuationToken = continuationToken,
                },
                ct);

            foreach (var stored in page.S3Objects ?? [])
            {
                keys.Add(stored.Key);
            }

            continuationToken = page.IsTruncated == true ? page.NextContinuationToken : null;
        }
        while (continuationToken is not null);

        return keys;
    }

    /// <inheritdoc />
    public async Task<int> DeleteAsync(
        IReadOnlyList<string> keys, CancellationToken ct = default)
    {
        var deleted = 0;

        foreach (var batch in keys.Chunk(DeleteBatchSize))
        {
            var response = await _client.DeleteObjectsAsync(
                new DeleteObjectsRequest
                {
                    BucketName = _options.Bucket,
                    Objects = [.. batch.Select(key => new KeyVersion { Key = key })],
                },
                ct);

            deleted += response.DeletedObjects?.Count ?? 0;
        }

        _logger.LogInformation(
            "Removed {Deleted} of {Requested} demo object(s) from {Bucket}.",
            deleted, keys.Count, _options.Bucket);

        return deleted;
    }

    public void Dispose() => _client.Dispose();
}
