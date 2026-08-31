using System.Net;
using System.Text.Json.Nodes;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Identity;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// Two phones, one code, exactly one device — proven, not hoped for.
/// <para>
/// <b>Why this is arranged with an interceptor rather than two parallel requests.</b> A test that
/// fired two activations at once and asserted that one lost would be a coin toss dressed up as a
/// test: on a fast machine the first would usually finish before the second started, and the
/// branch that matters would go unexercised for months. <see cref="InsertRaceInterceptor"/> runs a
/// complete second activation <em>immediately before</em> the first one's conditional UPDATE, so
/// the losing path runs every single time.
/// </para>
/// <para>
/// What the loser must do is the whole point: the code is already consumed, its UPDATE matches
/// zero rows, and the transaction rolls back — taking the device row it had already inserted with
/// it. A read-then-write implementation passes the happy path and fails exactly here, leaving two
/// live phones recording under one man's name.
/// </para>
/// </summary>
public sealed class ActivationRaceTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task Two_phones_racing_one_code_yield_exactly_one_device()
    {
        var code = await GivenLiveCodeAsync();

        string? winnerToken = null;

        App.RaceInterceptor.ArmOnceBeforeActivationCodeClaim(async () =>
        {
            // A DIFFERENT client, a DIFFERENT scope, a DIFFERENT transaction — the second phone,
            // typing the same code a moment earlier. It commits before the first one's claim runs.
            using var otherPhone = App.CreateAnonymousClient();

            var response = await otherPhone.PostJson(
                "/auth/activate",
                Body(DemoSeeder.WorkerUsername, code, "Drugi telefon"));

            response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
            winnerToken = (await response.JsonAsync()).GetText("device_token");
        });

        using var firstPhone = App.CreateAnonymousClient();
        var loser = await firstPhone.PostJson(
            "/auth/activate", Body(DemoSeeder.WorkerUsername, code, "Prvi telefon"));

        // The loser is refused, and is refused with the same answer a wrong code gets: "somebody
        // else took it a millisecond ago" is not something to tell a caller.
        loser.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        winnerToken.ShouldNotBeNull("the interceptor never fired; the race was not arranged");

        // ONE device. The loser's row went back with its transaction.
        var devices = await NewlyActivatedDevicesAsync();
        devices.Count.ShouldBe(1);
        devices[0].Name.ShouldBe("Drugi telefon");
        devices[0].RevokedAt.ShouldBeNull();

        // One consumed code, pointing at the one device that exists.
        var codes = await LoadActivationCodesAsync(TestIds.WorkerA);
        codes.Count.ShouldBe(1);
        codes[0].ConsumedAt.ShouldNotBeNull();
        codes[0].ConsumedDeviceId.ShouldBe(devices[0].Id);
        codes[0].CodeDisplay.ShouldBeNull();

        // And the winner's phone really is the one that records.
        using var winner = App.CreateClientWithToken(winnerToken!);
        (await winner.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private static JsonObject Body(string username, string code, string deviceName) => new()
    {
        ["username"] = username,
        ["activation_code"] = code,
        ["device_name"] = deviceName,
    };

    private async Task<string> GivenLiveCodeAsync()
    {
        await GivenCompanyAdminAsync();
        using var owner = await SignInAsync(TestIds.CompanyAdminAEmail);

        var response = await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        return ActivationCodeFormat.Fold((await response.JsonAsync()).GetText("code"));
    }
}
