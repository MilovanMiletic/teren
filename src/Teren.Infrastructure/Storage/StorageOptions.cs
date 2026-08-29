using System.ComponentModel.DataAnnotations;

namespace Teren.Infrastructure.Storage;

/// <summary>
/// Bound from the <c>Storage</c> configuration section. Local values live in
/// appsettings.Development.json (throwaway MinIO credentials from docker-compose.yml);
/// production supplies <c>Storage__Endpoint</c>, <c>Storage__AccessKey</c>,
/// <c>Storage__SecretKey</c>, <c>Storage__Bucket</c> as environment variables. Nothing real is
/// ever committed.
/// </summary>
public sealed class StorageOptions
{
    public const string SectionName = "Storage";

    /// <summary>S3 endpoint the API itself talks to (HEAD verification).</summary>
    [Required(AllowEmptyStrings = false)]
    public string Endpoint { get; set; } = string.Empty;

    /// <summary>
    /// Endpoint baked into presigned URLs, when the phone reaches storage at a different host
    /// than the API does — a tunnelled dev origin, or an internal address in production. Empty
    /// means "the same as <see cref="Endpoint"/>". It has to be a separate client because the
    /// host is part of what gets signed.
    /// </summary>
    public string PublicEndpoint { get; set; } = string.Empty;

    [Required(AllowEmptyStrings = false)]
    public string AccessKey { get; set; } = string.Empty;

    [Required(AllowEmptyStrings = false)]
    public string SecretKey { get; set; } = string.Empty;

    [Required(AllowEmptyStrings = false)]
    public string Bucket { get; set; } = string.Empty;

    /// <summary>Signing region. MinIO ignores it; a real S3 endpoint does not.</summary>
    public string Region { get; set; } = "us-east-1";

    /// <summary>MinIO and most S3-compatible stores need path-style addressing.</summary>
    public bool ForcePathStyle { get; set; } = true;

    /// <summary>Presigned URL lifetime (ARCHITECTURE §8: 15 minutes).</summary>
    [Range(typeof(TimeSpan), "00:01:00", "01:00:00")]
    public TimeSpan UploadUrlTtl { get; set; } = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Per-call ceiling on storage requests. The SDK's default is 100 seconds with four retries,
    /// which would let an unreachable storage host hold a phone-facing <c>/complete</c> for
    /// minutes. A foreman on a site needs an answer — even a "try again" — in seconds.
    /// </summary>
    [Range(typeof(TimeSpan), "00:00:01", "00:01:00")]
    public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Retries per storage call. Zero by default: an SDK retry inside a phone-facing request
    /// only multiplies the wait, and the phone's outbox is already the retry mechanism. A failed
    /// verification never becomes a verdict on the evidence — it becomes "try again".
    /// </summary>
    [Range(0, 5)]
    public int MaxRetries { get; set; }

    /// <summary>
    /// Ceiling on one <c>/complete</c> verification pass as a whole, not per object. Without it,
    /// a storage host that answers slowly rather than not at all would multiply
    /// <see cref="RequestTimeout"/> by up to <c>MediaPolicy.MaxMediaPerEntry</c> and pin the
    /// request for minutes — which is the failure mode the per-call timeout alone does not fix.
    /// </summary>
    [Range(typeof(TimeSpan), "00:00:02", "00:02:00")]
    public TimeSpan VerificationBudget { get; set; } = TimeSpan.FromSeconds(10);
}
