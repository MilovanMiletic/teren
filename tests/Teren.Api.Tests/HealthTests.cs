using System.Net;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

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
    public async Task The_test_host_talks_to_the_container_and_sees_the_baseline()
    {
        var response = await Client.Get("/api/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var projects = await response.JsonAsync();
        projects.EnumerateArray().Select(p => p.GetGuid("id"))
            .ShouldBe([TestIds.ProjectA1, TestIds.ProjectA2], ignoreOrder: true);
    }
}
