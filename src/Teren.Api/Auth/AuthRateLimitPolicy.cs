namespace Teren.Api.Auth;

/// <summary>
/// The name of the rate-limiting policy applied to <c>/auth/*</c>. A constant rather than a string
/// literal in two files, because <c>RequireRateLimiting</c> with a name no policy was registered
/// under throws at start-up on some paths and, worse, is easy to mistype into a route that then
/// silently has no limiter at all.
/// </summary>
public static class AuthRateLimitPolicy
{
    public const string Name = "auth";
}

/// <summary>
/// The name of the policy in front of <c>POST /api/client-events</c>, and the partition key it
/// counts against.
///
/// <para>
/// <b>Per credential, not per account — because a limiter is middleware and runs before the auth
/// filter</b>, so there is no <c>TerenPrincipal</c> to partition on yet. The bearer token is the
/// only stable per-caller fact available at that point, and it is <em>hashed</em> before it becomes
/// a dictionary key: the same SHA-256 the device table stores, never the plaintext.
/// </para>
/// <para>
/// The client address is in the key as well, and that is not weakening — it is what makes one
/// runaway phone unable to spend another phone's allowance, and what keeps a test suite's forty
/// clients out of each other's buckets. An anonymous request (which the auth filter is about to
/// refuse anyway) partitions on the address alone. What bounds memory under a flood of invented
/// tokens is not the key shape — every distinct Authorization value IS a new partition — but the
/// partitioned limiter's idle eviction: a fixed-window limiter reports idle once its one-minute
/// window replenishes untouched and is disposed, so growth is attacker rate × about two minutes ×
/// a few hundred bytes, and Kestrel's 32 KB header cap bounds the hash input.
/// </para>
/// </summary>
public static class ClientEventRateLimitPolicy
{
    public const string Name = "client-events";

    public static string PartitionKey(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        var address = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        var header = http.Request.Headers.Authorization.ToString();

        // Whatever was presented, reduced to 64 hex characters. Bearer or not, valid or not: this
        // is a bucket key, and judging the credential is the auth filter's job.
        return header.Length == 0
            ? address
            : address + "|" + Teren.Core.Identity.CredentialTokens.Hash(header);
    }
}
