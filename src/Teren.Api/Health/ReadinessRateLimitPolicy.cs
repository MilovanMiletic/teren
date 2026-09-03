namespace Teren.Api.Health;

/// <summary>
/// The fixed window in front of <c>/health/ready</c>, and the reason <c>/health</c> has none.
///
/// <para>
/// <b>The two routes cost different amounts, and that is the whole argument.</b> <c>/health</c> is
/// a constant — no allocation worth naming, no I/O — so a limiter in front of it would buy nothing
/// and could only ever refuse a liveness probe, which is how a healthy process gets restarted.
/// <c>/health/ready</c> is the opposite: it opens both <c>DbContext</c>s, runs <c>SELECT 1</c> on
/// each, reads both migration histories, and (where a job server is expected) reads Hangfire's
/// storage. That is four database round trips and a storage read per hit, on a public,
/// unauthenticated route, on a one-VPS product. Left unbounded it is a way to spend a small box's
/// database connections from the outside with a `for` loop.
/// </para>
///
/// <para>
/// <b>Generous on purpose, because the callers are machines with schedules.</b> The container
/// healthcheck asks every 15 s (<c>deploy/docker-compose.prod.yml</c>) and <c>deploy.sh</c> polls
/// up to thirty times at two-second intervals while a first deploy waits on ACME — about 34
/// requests a minute from those two together, and behind Caddy they can share a partition. A
/// monitoring probe is one or two more a minute. <see cref="PermitLimit"/> is roughly three and a
/// half times that, which leaves the numbers that actually run this product nowhere near the edge
/// while still bounding one address to two hits a second.
/// </para>
///
/// <para>
/// <b>A constant rather than a setting, deliberately.</b> Every other limit here is configurable;
/// this one is not, because the one thing that must never happen to this route is a deploy whose
/// own verification step is refused by a typo in an environment variable. There is nothing to tune
/// — the callers' cadences are fixed in the compose file and in <c>deploy.sh</c>, both of which
/// live in this repository.
/// </para>
///
/// <para>
/// Partitioned on the client address, exactly as <see cref="Teren.Api.Auth.AuthRateLimitPolicy"/>
/// is: <c>RemoteIpAddress</c> is trustworthy because <c>Hosting:BehindProxy</c> wires
/// <c>UseForwardedHeaders</c> on the hosts that sit behind Caddy, and the API port is not published
/// there. A null address collapses to one shared partition, which is the safe direction.
/// </para>
/// </summary>
public static class ReadinessRateLimitPolicy
{
    public const string Name = "readiness";

    /// <summary>Requests per <see cref="Window"/> per client address.</summary>
    public const int PermitLimit = 120;

    public static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
}
