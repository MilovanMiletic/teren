using System.Net;
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
    public async Task The_test_host_talks_to_the_container_and_sees_the_baseline()
    {
        var response = await Client.Get("/api/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var projects = await response.JsonAsync();
        projects.EnumerateArray().Select(p => p.GetGuid("id"))
            .ShouldBe([TestIds.ProjectA1, TestIds.ProjectA2], ignoreOrder: true);
    }
}
