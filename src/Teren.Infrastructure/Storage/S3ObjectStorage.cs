using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Storage;

namespace Teren.Infrastructure.Storage;

/// <summary>
/// S3-compatible object storage: MinIO locally, Hetzner Object Storage in production — the same
/// code in both places, which is the reason MinIO is in docker-compose at all.
/// </summary>
public sealed class S3ObjectStorage : IObjectStorage, IDisposable
{
    private readonly AmazonS3Client _internalClient;

    /// <summary>Signs URLs against the host the phone will use; identical to
    /// <see cref="_internalClient"/> unless <c>Storage:PublicEndpoint</c> is set.</summary>
    private readonly AmazonS3Client _presignClient;

    private readonly bool _presignClientIsSeparate;

    /// <summary>
    /// A third client purely for downloading media in the background pipeline. It exists
    /// because the other two are tuned for a phone-facing request — 5 s and no retries — and
    /// a 25 MB voice note read under that budget would abort mid-stream on a slow link. A
    /// Hangfire job has time; a foreman standing on a site does not. Separate client rather
    /// than a per-call override because the timeout lives on the SDK config, not the request.
    /// </summary>
    private readonly AmazonS3Client _downloadClient;

    /// <summary>True when the presigning endpoint is plain HTTP — see the note in
    /// <see cref="CreatePresignedUploadAsync"/>.</summary>
    private readonly bool _presignOverHttp;

    private readonly StorageOptions _options;
    private readonly ILogger<S3ObjectStorage> _logger;

    public S3ObjectStorage(IOptions<StorageOptions> options, ILogger<S3ObjectStorage> logger)
    {
        _options = options.Value;
        _logger = logger;

        var credentials = new BasicAWSCredentials(_options.AccessKey, _options.SecretKey);
        _internalClient = new AmazonS3Client(credentials, BuildConfig(_options.Endpoint));

        _presignClientIsSeparate =
            !string.IsNullOrWhiteSpace(_options.PublicEndpoint)
            && !string.Equals(_options.PublicEndpoint, _options.Endpoint, StringComparison.OrdinalIgnoreCase);

        var presignEndpoint = _presignClientIsSeparate ? _options.PublicEndpoint : _options.Endpoint;
        _presignOverHttp = presignEndpoint.StartsWith("http://", StringComparison.OrdinalIgnoreCase);

        _presignClient = _presignClientIsSeparate
            ? new AmazonS3Client(credentials, BuildConfig(_options.PublicEndpoint))
            : _internalClient;

        _downloadClient = new AmazonS3Client(
            credentials, BuildConfig(_options.Endpoint, forDownload: true));
    }

    private AmazonS3Config BuildConfig(string serviceUrl, bool forDownload = false) => new()
    {
        ServiceURL = serviceUrl,
        // The SDK rewrites the scheme to https unless UseHttp is set, which would hand the phone
        // a presigned URL that local MinIO cannot answer. Honour the scheme actually configured;
        // staging and production configure https and get https.
        UseHttp = serviceUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase),
        ForcePathStyle = _options.ForcePathStyle,
        AuthenticationRegion = _options.Region,
        // The API never uploads bytes itself, so the SDK's default flexible-checksum behaviour
        // would only add headers that a presigned PUT from the phone cannot reproduce.
        RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
        ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
        // Bounded waiting: /complete is a phone-facing request and must not inherit the SDK's
        // 100 s / 4 retries when the storage host black-holes packets. The download client is
        // the deliberate exception — it runs inside a Hangfire job, moves whole files, and would
        // abort a large voice note mid-stream under the request budget.
        Timeout = forDownload ? _options.DownloadTimeout : _options.RequestTimeout,
        MaxErrorRetry = forDownload ? _options.DownloadRetries : _options.MaxRetries,
    };

    /// <inheritdoc />
    public async ValueTask<PresignedUpload> CreatePresignedUploadAsync(
        string objectKey, string contentType, TimeSpan ttl, CancellationToken ct = default)
    {
        var expiresAt = DateTimeOffset.UtcNow.Add(ttl);

        // Local signature computation, not a call to storage: safe inside a phone-facing request.
        var url = await _presignClient.GetPreSignedURLAsync(new GetPreSignedUrlRequest
        {
            BucketName = _options.Bucket,
            Key = objectKey,
            Verb = HttpVerb.PUT,
            Expires = expiresAt.UtcDateTime,
            // Signed in, so the uploaded object cannot be given a different type than declared —
            // and the client must echo the header back exactly.
            ContentType = contentType,
        });

        // AWSSDK.S3 4.x emits https:// for presigned URLs whatever the configured endpoint says
        // (verified against 4.0.102: neither ServiceURL's scheme nor UseHttp changes it). Local
        // MinIO speaks plain HTTP, so the URL is put back on the scheme that was configured.
        // Safe: SigV4 signs the host header, the path and the query — never the scheme. Nothing
        // in production runs on http, so this only ever fires on a dev machine.
        if (_presignOverHttp && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            url = string.Concat("http://", url.AsSpan("https://".Length));
        }

        return new PresignedUpload(
            url,
            "PUT",
            expiresAt,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Content-Type"] = contentType,
            });
    }

    /// <inheritdoc />
    public async Task<StoredObject?> HeadAsync(string objectKey, CancellationToken ct = default)
    {
        try
        {
            var metadata = await _internalClient.GetObjectMetadataAsync(
                new GetObjectMetadataRequest { BucketName = _options.Bucket, Key = objectKey }, ct);

            return new StoredObject(
                metadata.ContentLength,
                metadata.ETag,
                metadata.LastModified ?? DateTime.UnixEpoch);
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            // An ordinary answer: the object is not there (yet). Not a failure of any kind.
            _logger.LogInformation("Object {ObjectKey} is not in storage.", objectKey);
            return null;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The caller went away; that is not a storage problem.
            throw;
        }
        catch (Exception ex) when (ex is AmazonServiceException
                                       or HttpRequestException
                                       or OperationCanceledException
                                       or TimeoutException)
        {
            // Unreachable, refused, or slower than the timeout. The server does not know whether
            // the object arrived, so it must say so rather than record a verdict on the evidence.
            _logger.LogError(
                ex, "Object storage did not answer for {ObjectKey}.", objectKey);

            throw new ObjectStorageUnavailableException(
                "Object storage did not answer within "
                + $"{_options.RequestTimeout.TotalSeconds:0.#} s.", ex);
        }
    }

    /// <inheritdoc />
    public async Task<Stream?> OpenReadAsync(string objectKey, CancellationToken ct = default)
    {
        try
        {
            var response = await _downloadClient.GetObjectAsync(
                new GetObjectRequest { BucketName = _options.Bucket, Key = objectKey }, ct);

            // The caller owns the stream; disposing it disposes the response with it.
            return response.ResponseStream;
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            // Verified at /complete, gone now. Not an outage — a real, reportable problem with
            // this entry's evidence, so it is null rather than an exception.
            _logger.LogWarning(
                "Object {ObjectKey} is not in storage; it was verified at completion.", objectKey);
            return null;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is AmazonServiceException
                                       or HttpRequestException
                                       or OperationCanceledException
                                       or TimeoutException)
        {
            _logger.LogError(ex, "Object storage did not answer for {ObjectKey}.", objectKey);

            throw new ObjectStorageUnavailableException(
                "Object storage did not answer within "
                + $"{_options.DownloadTimeout.TotalSeconds:0.#} s.", ex);
        }
    }

    public void Dispose()
    {
        _internalClient.Dispose();
        _downloadClient.Dispose();
        if (_presignClientIsSeparate)
        {
            _presignClient.Dispose();
        }
    }
}
