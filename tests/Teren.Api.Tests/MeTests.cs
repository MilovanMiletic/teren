using System.Net;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// <c>GET /api/me</c> — the PWA's "is my credential still good" probe, and the only place the app
/// learns who it is signed in as.
/// <para>
/// It has no role gate, deliberately: every role has a "me", and a route that answers only "who is
/// holding this token" cannot tell the holder anything he does not already have.
/// </para>
/// </summary>
public sealed class MeTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task A_phone_learns_its_worker_its_company_and_its_device()
    {
        var response = await Client.Get("/api/me");
        response.StatusCode.ShouldBe(HttpStatusCode.OK);

        var body = await response.JsonAsync();

        body.GetText("role").ShouldBe(AppUserRoleNames.Worker);
        body.GetGuid("user_id").ShouldBe(TestIds.WorkerA);
        body.GetText("username").ShouldBe(DemoSeeder.WorkerUsername);
        body.GetText("display_name").ShouldBe("Zoran Jovanović");
        body.GetProperty("company").GetGuid("id").ShouldBe(TestIds.CompanyA);
        body.GetProperty("company").GetText("name").ShouldBe(TestIds.CompanyAName);
        body.GetProperty("device").GetGuid("id").ShouldBe(TestIds.DeviceA);
    }

    [Fact]
    public async Task An_admin_has_no_device_and_no_username()
    {
        using var owner = await GivenCompanyAdminClientAsync();

        var body = await (await owner.Get("/api/me")).JsonAsync();

        body.GetText("role").ShouldBe(AppUserRoleNames.CompanyAdmin);
        body.IsNull("device").ShouldBeTrue();
        body.IsNull("username").ShouldBeTrue();
        body.GetProperty("company").GetGuid("id").ShouldBe(TestIds.CompanyA);
    }

    [Fact]
    public async Task It_is_401_without_a_credential_and_401_after_revocation()
    {
        // This is the probe the app uses to decide whether it is still activated, so the two
        // answers it can give have to be the two the app branches on — and revocation has to reach
        // it on the very next request, with no sleep anywhere in this test.
        using var anonymous = App.CreateAnonymousClient();
        (await anonymous.Get("/api/me")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        using var owner = await GivenCompanyAdminClientAsync();
        await owner.Delete($"/api/devices/{TestIds.DeviceA}");

        (await Client.Get("/api/me")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task It_carries_no_credential_of_any_kind()
    {
        // A probe that echoed a token would put the credential into every log, proxy and browser
        // cache that ever sees a response body.
        var body = await (await Client.Get("/api/me")).TextAsync();

        body.ShouldNotContain(TerenTestApp.DeviceToken);
        body.ShouldNotContain("token");
        body.ShouldNotContain("password");
    }
}
