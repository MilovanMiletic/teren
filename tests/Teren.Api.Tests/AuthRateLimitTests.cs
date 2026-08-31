using System.Net;
using System.Text.Json.Nodes;
using Teren.Api.Auth;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// The fixed window in front of <c>/auth/*</c> (§7): ten attempts per five minutes per client IP.
/// <para>
/// <b>By IP and not by account, and that is a security decision rather than an omission.</b> A
/// per-account lockout hands an attacker a way to lock a paying customer out of his own reports
/// with nothing but an email address. Making guessing slow from one place is the half of the
/// problem that can be solved without handing anyone that lever.
/// </para>
/// <para>
/// Every other test in this suite gets its own client IP from
/// <see cref="TerenTestApp.CreateAnonymousClient"/>, so the shipped limit stays in place for the
/// whole run instead of being raised for the convenience of the suite. This file is the one that
/// deliberately reuses an address.
/// </para>
/// </summary>
public sealed class AuthRateLimitTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task Guessing_from_one_address_is_refused_after_the_permitted_attempts()
    {
        var limit = new AuthRateLimitOptions().PermitLimit;
        var ip = App.NextClientIp();

        using var attacker = App.CreateAnonymousClient(ip);

        for (var attempt = 0; attempt < limit; attempt++)
        {
            var response = await Login(attacker, $"guess{attempt}");

            // Every one of these is refused on the merits, not by the limiter — otherwise the
            // assertion below would be counting the wrong thing.
            response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        }

        var blocked = await Login(attacker, "one-guess-too-many");

        blocked.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);

        // Retry-After, so a client can wait the right amount rather than hammer.
        blocked.Headers.RetryAfter.ShouldNotBeNull();

        // Problem details like every other refusal in this API, and it says nothing about which
        // account was being tried.
        var body = await blocked.TextAsync();
        body.ShouldContain("Too many requests");
        body.ShouldNotContain("one-guess-too-many");
    }

    [Fact]
    public async Task One_address_being_throttled_does_not_lock_anybody_else_out()
    {
        // The property that makes an IP limiter acceptable at all: an attacker cannot use it to
        // lock a paying customer out of his own reports.
        await GivenCompanyAdminAsync();

        var ip = App.NextClientIp();
        using var attacker = App.CreateAnonymousClient(ip);

        for (var attempt = 0; attempt <= new AuthRateLimitOptions().PermitLimit; attempt++)
        {
            await Login(attacker, $"guess{attempt}");
        }

        (await Login(attacker, AdminPassword)).StatusCode
            .ShouldBe(HttpStatusCode.TooManyRequests);

        // The customer, from his own address, on the same account the attacker was hammering.
        using var customer = App.CreateAnonymousClient();

        (await Login(customer, AdminPassword)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_activation_route_is_behind_the_same_window()
    {
        // A code is only 40 bits. Without a limiter in front of it, guessing one for a known
        // username is a script rather than a theory.
        var ip = App.NextClientIp();
        using var attacker = App.CreateAnonymousClient(ip);

        for (var attempt = 0; attempt < new AuthRateLimitOptions().PermitLimit; attempt++)
        {
            var response = await attacker.PostJson(
                "/auth/activate",
                new JsonObject
                {
                    ["username"] = "zoran.jovanovic",
                    ["activation_code"] = "ZZZZ-ZZZZ",
                });

            response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        }

        var blocked = await attacker.PostJson(
            "/auth/activate",
            new JsonObject
            {
                ["username"] = "zoran.jovanovic",
                ["activation_code"] = "ZZZZ-ZZZZ",
            });

        blocked.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task The_limiter_does_not_reach_the_authenticated_api()
    {
        // A foreman's phone syncing a morning's backlog makes far more than ten requests. The
        // limiter guards the credential surface only, and putting it on /api would turn a busy
        // upload queue into a stuck one.
        for (var i = 0; i < new AuthRateLimitOptions().PermitLimit + 5; i++)
        {
            (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
    }

    private static Task<HttpResponseMessage> Login(HttpClient client, string password) =>
        client.PostJson(
            "/auth/login",
            new JsonObject
            {
                ["email"] = TestIds.CompanyAdminAEmail,
                ["password"] = password,
            });
}
