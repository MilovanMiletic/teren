using System.Net;
using Teren.Api.Health;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// The two health routes, and they are two different questions.
/// <para>
/// <c>/health</c> is liveness: the process is up and answering, and it is a constant on purpose —
/// a probe that goes red because a database blinked is a probe that restarts a healthy process.
/// <c>/health/ready</c> asks whether this host can actually serve a request, which is what
/// <c>deploy.sh</c> and the container healthcheck ask. Its failure paths need half-migrated
/// databases and live in <see cref="ReadinessTests"/>.
/// </para>
/// </summary>
public sealed class HealthTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task Health_is_reachable_without_a_token()
    {
        using var anonymous = App.CreateAnonymousClient();

        var response = await anonymous.Get("/health");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var body = await response.JsonAsync();
        body.GetText("status").ShouldBe("ok");
        body.GetText("service").ShouldBe("teren-api");
    }

    [Fact]
    public async Task Readiness_answers_healthy_on_a_migrated_host()
    {
        // Both contexts answer, both migration histories are current, and the job server is not
        // checked here because the suite runs with Hangfire__Enabled=false — that check is
        // registered only where a job server is expected, which is the same respect for the
        // switch that keeps the upload path runnable without one.
        using var anonymous = App.CreateAnonymousClient();

        var response = await anonymous.Get("/health/ready");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.TextAsync()).Trim().ShouldBe("Healthy");
    }

    [Fact]
    public async Task Readiness_refuses_a_caller_who_asks_faster_than_any_probe_would()
    {
        // WHY THIS ROUTE HAS A LIMITER AND /health DOES NOT: readiness opens both DbContexts, runs
        // SELECT 1 on each, reads both migration histories and (where a job server is expected)
        // reads Hangfire's storage. That is four database round trips per hit, answered to anybody,
        // on a one-VPS product — a way to spend a small box's connections from the outside with a
        // `for` loop. /health is a constant and stays free.
        var ip = App.NextClientIp();
        using var probe = App.CreateAnonymousClient(ip);

        for (var attempt = 0; attempt < ReadinessRateLimitPolicy.PermitLimit; attempt++)
        {
            // Every one of these is answered on the merits, not by the limiter — otherwise the
            // assertion below would be counting the wrong thing.
            (await probe.GetAsync("/health/ready", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        var blocked = await probe.GetAsync("/health/ready", Ct);

        blocked.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        blocked.Headers.RetryAfter.ShouldNotBeNull("a probe must be told how long to wait");
    }

    [Fact]
    public async Task The_shipped_probes_are_nowhere_near_the_readiness_limit()
    {
        // The number is only defensible if the callers this repository actually ships stay well
        // under it. The container healthcheck asks every 15 s (4/min) and `deploy.sh` polls up to
        // thirty times at two-second intervals while a first deploy waits on ACME (~30/min) —
        // and behind Caddy those two can share a partition.
        const int ContainerHealthchecksPerMinute = 4;
        const int DeployPollsPerMinute = 30;

        ReadinessRateLimitPolicy.Window.ShouldBe(TimeSpan.FromMinutes(1));

        ReadinessRateLimitPolicy.PermitLimit.ShouldBeGreaterThan(
            3 * (ContainerHealthchecksPerMinute + DeployPollsPerMinute),
            "a limit that a deploy's own verification loop can reach is an outage waiting for a "
            + "slow ACME issuance");

        // And the cadences it is measured against are the ones in the repository, not a memory of
        // them: if the compose healthcheck speeds up, this recomputation is where it shows.
        var compose = await File.ReadAllTextAsync(
            Path.Combine(SourceTree.RepoRoot(), "deploy", "docker-compose.prod.yml"), Ct);

        compose.ShouldContain("http://127.0.0.1:8080/health/ready");
        compose.ShouldContain("interval: 15s");

        var deploy = await File.ReadAllTextAsync(
            Path.Combine(SourceTree.RepoRoot(), "deploy", "deploy.sh"), Ct);

        deploy.ShouldContain("for i in $(seq 1 30); do");
        deploy.ShouldContain("sleep 2");

        // Liveness stays free. A probe that goes red because a limiter fired is a probe that
        // restarts a healthy process.
        using var liveness = App.CreateAnonymousClient();

        for (var attempt = 0; attempt < ReadinessRateLimitPolicy.PermitLimit + 5; attempt++)
        {
            (await liveness.GetAsync("/health", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
    }

    [Fact]
    public async Task The_test_host_talks_to_the_container_and_sees_the_baseline()
    {
        var response = await Client.Get("/api/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var projects = await response.JsonAsync();
        projects.EnumerateArray().Select(p => p.GetGuid("id"))
            .ShouldBe([TestIds.ProjectA1, TestIds.ProjectA2], ignoreOrder: true);
    }
}
