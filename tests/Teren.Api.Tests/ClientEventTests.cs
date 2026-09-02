using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Teren.Infrastructure.Logging;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// <c>POST /api/client-events</c> — the phone's half of the log stream (D5, contract §3).
///
/// <para>
/// Every assertion here is about one of three things: <b>who may call it</b> (anyone
/// authenticated, phone or admin), <b>where the company comes from</b> (the caller's credential,
/// never the body), and <b>what a phone can and cannot get into the log table</b> (slugs, ids,
/// numbers — never a sentence). The third is a security boundary rather than input hygiene:
/// these rows end up on a screen Teren staff read, and the product's central claim is that they
/// cannot read a customer's work.
/// </para>
/// </summary>
public sealed class ClientEventTests(TerenTestApp app) : ApiTestBase(app)
{
    private static JsonObject Event(
        string action = "capture.record.stop",
        string route = "/snimanje",
        string? outcome = "ok",
        long? durationMs = 31_200,
        Guid? id = null,
        Guid? entryId = null,
        Guid? projectId = null,
        JsonObject? detail = null,
        string? at = null)
    {
        var body = new JsonObject
        {
            ["id"] = (id ?? Guid.NewGuid()).ToString(),
            ["at"] = at ?? DateTimeOffset.UtcNow.ToString("O"),
            ["action"] = action,
            ["route"] = route,
        };

        if (outcome is not null)
        {
            body["outcome"] = outcome;
        }

        if (durationMs is not null)
        {
            body["duration_ms"] = durationMs.Value;
        }

        if (entryId is not null)
        {
            body["entry_id"] = entryId.Value.ToString();
        }

        if (projectId is not null)
        {
            body["project_id"] = projectId.Value.ToString();
        }

        if (detail is not null)
        {
            body["detail"] = detail;
        }

        return body;
    }

    private static JsonObject Batch(params JsonObject[] events) =>
        new() { ["events"] = new JsonArray([.. events.Select(e => e.DeepClone())]) };

    private async Task<List<AppLog>> StoredAsync()
    {
        await App.FlushLogsAsync(Ct);

        await using var identity = App.CreateIdentityDbContext();
        return await identity.Logs.AsNoTracking()
            .Where(l => l.Source.StartsWith("web."))
            .OrderBy(l => l.Id)
            .ToListAsync(Ct);
    }

    // ------------------------------------------------------------------------------ the gate

    [Fact]
    public async Task A_phone_may_report_and_so_may_an_admin()
    {
        // Both credentials, deliberately. A worker's phone and an owner's browser are the same
        // product, and the founder asked for every action in the app.
        var phone = await Client.PostJson("/api/client-events", Batch(Event()));
        phone.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        using var admin = await GivenCompanyAdminClientAsync();
        var office = await admin.PostJson(
            "/api/client-events", Batch(Event(action: "company.worker.open", route: "/firma")));
        office.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        using var staff = await GivenSuperAdminClientAsync();
        var platform = await staff.PostJson(
            "/api/client-events", Batch(Event(action: "logs.open", route: "/platforma/logovi")));
        platform.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        (await StoredAsync()).Count.ShouldBe(3);
    }

    [Fact]
    public async Task An_anonymous_caller_is_refused()
    {
        using var anonymous = App.CreateAnonymousClient();

        (await anonymous.PostJson("/api/client-events", Batch(Event()))).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
    }

    // ------------------------------------------------------------------------------ the scope

    [Fact]
    public async Task The_company_comes_from_the_credential_and_the_body_cannot_name_one()
    {
        // A phone that could name its own company could write rows against another customer's
        // account — the cheapest way to make the one stream Teren staff trust untrustworthy. The
        // field is not in the request shape at all, so an attempt at it is simply ignored.
        var smuggled = Event();
        smuggled["company_id"] = TestIds.CompanyB.ToString();

        var response = await Client.PostJson("/api/client-events", Batch(smuggled));
        response.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        var stored = await StoredAsync();
        stored.Count.ShouldBe(1);
        stored[0].CompanyId.ShouldBe(TestIds.CompanyA, "the caller's company, not the body's");
    }

    [Fact]
    public async Task A_super_admin_writes_a_row_with_no_company_at_all()
    {
        // He has none by construction (ck_app_user_company_scope), and a log row about the
        // platform surface belongs to no tenant. NULL is the honest answer, not Guid.Empty.
        using var staff = await GivenSuperAdminClientAsync();

        await staff.PostJson(
            "/api/client-events", Batch(Event(action: "logs.export", route: "/platforma/logovi")));

        var stored = await StoredAsync();
        stored.Count.ShouldBe(1);
        stored[0].CompanyId.ShouldBeNull();
    }

    // ------------------------------------------------------------------------------ the shape

    [Fact]
    public async Task A_good_event_becomes_a_log_row_with_the_contracted_shape()
    {
        var id = Guid.NewGuid();
        var entryId = Guid.NewGuid();

        await Client.PostJson(
            "/api/client-events",
            Batch(Event(
                id: id,
                entryId: entryId,
                detail: new JsonObject { ["chunks"] = 31, ["bytes"] = 412_330 })));

        var stored = await StoredAsync();
        var row = stored.ShouldHaveSingleItem();

        row.Source.ShouldBe("web.capture", "source is web.<first segment of action>");
        row.Template.ShouldBe("capture.record.stop", "the template is the action slug");
        row.Level.ShouldBe(AppLogLevels.Information);
        row.EntryId.ShouldBe(entryId, "from the body — an id is not evidence");
        row.Correlation.ShouldBe(id.ToString(), "the client event id, so a replay is recognisable");
        row.Message.ShouldContain("capture.record.stop");
        row.Message.ShouldContain("/snimanje");

        using var properties = JsonDocument.Parse(row.Properties!);
        properties.RootElement.GetProperty("route").GetString().ShouldBe("/snimanje");
        properties.RootElement.GetProperty("outcome").GetString().ShouldBe("ok");
        properties.RootElement.GetProperty("duration_ms").GetInt64().ShouldBe(31_200);
        properties.RootElement.GetProperty("detail").GetProperty("chunks").GetInt32().ShouldBe(31);

        // Who was holding the credential, from the principal and never from the body.
        properties.RootElement.GetProperty("user_id").GetString().ShouldBe(TestIds.WorkerA.ToString());
        properties.RootElement.GetProperty("device_id").GetString()
            .ShouldBe(TestIds.DeviceA.ToString());
    }

    [Fact]
    public async Task A_failed_action_is_stored_as_a_warning()
    {
        // So that "what is failing" — the level filter an operator actually reaches for —
        // includes the app and not only the server.
        await Client.PostJson(
            "/api/client-events", Batch(Event(action: "capture.send", outcome: "fail")));

        (await StoredAsync()).ShouldHaveSingleItem().Level.ShouldBe(AppLogLevels.Warning);
    }

    // ------------------------------------------------------------------------------ rejection

    [Theory]
    // A sentence where a slug belongs is the shape this route exists to refuse.
    [InlineData("danas smo zavrsili kupatilo na drugom spratu")]
    [InlineData("Capture.Record.Stop")]
    [InlineData("capture")]
    [InlineData("a.b.c.d.e.f")]
    public async Task An_action_that_is_not_a_slug_is_rejected_whole(string action)
    {
        var response = await Client.PostJson("/api/client-events", Batch(Event(action: action)));

        var body = await response.JsonAsync();
        response.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        body.GetProperty("accepted").GetInt32().ShouldBe(0);
        body.GetProperty("rejected").GetInt32().ShouldBe(1);

        (await StoredAsync()).ShouldBeEmpty();
    }

    [Theory]
    // A route may carry an id. It may never carry what somebody typed.
    [InlineData("/pretraga?q=kupatilo+na+drugom+spratu")]
    [InlineData("/arhiva#beleska")]
    [InlineData("snimanje")]
    [InlineData("/ovo je ruta")]
    public async Task A_route_with_a_query_string_or_a_fragment_is_rejected_whole(string route)
    {
        var body = await (await Client.PostJson(
            "/api/client-events", Batch(Event(route: route)))).JsonAsync();

        body.GetProperty("rejected").GetInt32().ShouldBe(1);
        (await StoredAsync()).ShouldBeEmpty();
    }

    [Fact]
    public async Task A_route_that_carries_an_id_is_kept()
    {
        var body = await (await Client.PostJson(
            "/api/client-events",
            Batch(Event(
                action: "archive.entry.open",
                route: "/arhiva/9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f")))).JsonAsync();

        body.GetProperty("accepted").GetInt32().ShouldBe(1);
    }

    [Fact]
    public async Task An_unknown_outcome_or_an_absurd_duration_is_rejected_whole()
    {
        var bad = Event();
        bad["outcome"] = "kinda-ok";

        var slow = Event();
        slow["duration_ms"] = 99_999_999;

        var body = await (await Client.PostJson(
            "/api/client-events", Batch(bad, slow, Event()))).JsonAsync();

        body.GetProperty("accepted").GetInt32().ShouldBe(1);
        body.GetProperty("rejected").GetInt32().ShouldBe(2);
    }

    [Fact]
    public async Task A_partly_bad_batch_is_still_202_and_the_good_rows_survive()
    {
        // Never a 4xx for a partly bad batch: the phone is an offline-first client with a queue,
        // and a rejection makes it retry the same batch for ever because one row in it was
        // malformed.
        var response = await Client.PostJson(
            "/api/client-events",
            Batch(Event(action: "capture.send"), Event(action: "NOT A SLUG"), Event(action: "nav.route.enter")));

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        var body = await response.JsonAsync();
        body.GetProperty("accepted").GetInt32().ShouldBe(2);
        body.GetProperty("rejected").GetInt32().ShouldBe(1);

        (await StoredAsync()).Count.ShouldBe(2);
    }

    // ------------------------------------------------------------------------------ detail

    [Fact]
    public async Task A_detail_value_that_is_not_a_number_boolean_or_slug_is_dropped_and_the_event_kept()
    {
        // The one rule that makes "there is no path by which free text from a phone reaches the
        // log table" true. The event still says what the person did, which is the more valuable
        // half — throwing it away over one malformed extra fact would lose that.
        var detail = new JsonObject
        {
            ["chunks"] = 31,
            ["ok"] = true,
            ["mode"] = "hands-free",
            ["note"] = "danas smo zavrsili kupatilo",
            ["nested"] = new JsonObject { ["x"] = 1 },
            ["list"] = new JsonArray(1, 2),
            ["Bad-Key"] = 1,
        };

        var body = await (await Client.PostJson(
            "/api/client-events", Batch(Event(detail: detail)))).JsonAsync();

        body.GetProperty("accepted").GetInt32().ShouldBe(1);
        body.GetProperty("rejected").GetInt32().ShouldBe(0);

        var row = (await StoredAsync()).ShouldHaveSingleItem();

        row.Properties.ShouldNotBeNull().ShouldNotContain("kupatilo");

        using var properties = JsonDocument.Parse(row.Properties!);
        var kept = properties.RootElement.GetProperty("detail");

        kept.GetProperty("chunks").GetInt32().ShouldBe(31);
        kept.GetProperty("ok").GetBoolean().ShouldBeTrue();
        kept.GetProperty("mode").GetString().ShouldBe("hands-free");
        kept.TryGetProperty("note", out _).ShouldBeFalse();
        kept.TryGetProperty("nested", out _).ShouldBeFalse();
        kept.TryGetProperty("list", out _).ShouldBeFalse();
        kept.TryGetProperty("Bad-Key", out _).ShouldBeFalse();
    }

    [Fact]
    public async Task Detail_stops_at_ten_keys()
    {
        var detail = new JsonObject();
        for (var i = 0; i < 25; i++)
        {
            detail[$"k{i}"] = i;
        }

        await Client.PostJson("/api/client-events", Batch(Event(detail: detail)));

        var row = (await StoredAsync()).ShouldHaveSingleItem();

        using var properties = JsonDocument.Parse(row.Properties!);
        properties.RootElement.GetProperty("detail").EnumerateObject().Count().ShouldBe(10);
    }

    // ------------------------------------------------------------------------------ envelope

    [Fact]
    public async Task A_batch_with_no_events_array_is_a_400()
    {
        // The envelope is the one thing worth a validation problem: a caller sending no `events`
        // has misunderstood the route, and telling him is cheap.
        var response = await Client.PostJson("/api/client-events", new JsonObject());

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.TextAsync()).ShouldContain("events");
    }

    [Fact]
    public async Task An_empty_batch_is_accepted_and_writes_nothing()
    {
        var body = await (await Client.PostJson(
            "/api/client-events", new JsonObject { ["events"] = new JsonArray() })).JsonAsync();

        body.GetProperty("accepted").GetInt32().ShouldBe(0);
        (await StoredAsync()).ShouldBeEmpty();
    }

    [Fact]
    public void The_body_cap_is_on_the_endpoint_and_not_in_the_handler()
    {
        // The cap used to be a `ContentLength` check inside the handler, which bounded nothing: it
        // ran after model binding had already deserialised whatever arrived, and a chunked request
        // sends no Content-Length at all — so the route's real ceiling was Kestrel's 30 MB
        // default. As endpoint metadata it is applied before the body is read, chunked or not.
        //
        // Asserted as wiring rather than over HTTP because the in-memory TestServer does not
        // enforce a body-size limit at all; a request-shaped test here would answer 202 and prove
        // the opposite of what it claimed. The behaviour is proven against real Kestrel — 413 for
        // both a chunked and a Content-Length body — and recorded in the D5 review notes.
        var expected = App.Factory.Services
            .GetRequiredService<IOptions<LoggingOptions>>().Value.ClientEvents.MaxBodyBytes;

        var endpoint = App.Factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Single(e => e.RoutePattern.RawText == "/api/client-events");

        var limit = endpoint.Metadata.GetMetadata<IRequestSizeLimitMetadata>().ShouldNotBeNull(
            "POST /api/client-events declares no body-size limit, so Kestrel's 30 MB default is "
            + "the cap and this route is a way to push megabytes at the log table.");

        limit.MaxRequestBodySize.ShouldBe(expected);
    }

    [Fact]
    public async Task More_than_a_hundred_events_is_a_400()
    {
        var events = Enumerable.Range(0, 101).Select(_ => Event()).ToArray();

        var response = await Client.PostJson("/api/client-events", Batch(events));

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task An_event_stamped_in_the_future_is_stamped_now_rather_than_refused()
    {
        // A phone's clock drifts and travels. What the person did is worth more than what his
        // clock said, and an event dated next year would sit at the top of the viewer for ever.
        var before = DateTime.UtcNow;

        await Client.PostJson(
            "/api/client-events",
            Batch(Event(at: DateTimeOffset.UtcNow.AddYears(1).ToString("O"))));

        var row = (await StoredAsync()).ShouldHaveSingleItem();

        row.At.ShouldBeGreaterThanOrEqualTo(before.AddSeconds(-1));
        row.At.ShouldBeLessThanOrEqualTo(DateTime.UtcNow.AddSeconds(1));
    }

    // ---------------------------------------------------------------- the rate limit

    /// <summary>
    /// The cap on the body bounds one request; nothing bounded a caller.
    /// <para>
    /// <b>Why that mattered more here than on an ordinary route.</b> The queue behind this one is
    /// bounded and drops the <em>oldest</em> row when full — right for a stuck writer, and wrong
    /// for a loud client: one phone in a retry loop would push every server-side line out of the
    /// table Teren staff read to find out what is going wrong. The limiter is middleware, so it
    /// runs before the auth filter; the credential's hash is the only per-caller thing that exists
    /// at that point, which is why the partition is that and not the principal.
    /// </para>
    /// <para>
    /// Deliberately driven with a bogus token: the 429 arrives <em>before</em> the 401, and using
    /// a token no other test shares keeps this test's sixty requests out of the fixture device's
    /// bucket — a fixed window is a minute long and the suite runs in one.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_client_that_floods_the_route_is_refused_before_it_can_fill_the_queue()
    {
        var limit = App.Factory.Services
            .GetRequiredService<IOptions<LoggingOptions>>().Value.ClientEvents.RateLimitPerMinute;

        limit.ShouldBe(60, "the shipped allowance for a phone; generous, and not unbounded");

        using var loud = App.CreateClientWithToken("trn_d_not-a-real-token-flooder");

        for (var i = 1; i <= limit; i++)
        {
            var allowed = await loud.PostJson("/api/client-events", Batch(Event()));

            // Refused on the credential, which is the auth filter's job — the point is that the
            // limiter let it through to be judged.
            allowed.StatusCode.ShouldBe(
                HttpStatusCode.Unauthorized,
                $"request {i} of {limit} should still be inside the window's allowance");
        }

        var refused = await loud.PostJson("/api/client-events", Batch(Event()));

        refused.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        refused.Headers.RetryAfter.ShouldNotBeNull(
            "a phone has to be told how long to wait, or it retries into the same wall");

        // Problem details like every other refusal in this API, and it names no account.
        var body = await refused.TextAsync();
        body.ShouldContain("Too many requests");
        body.ShouldNotContain("trn_d_", Case.Sensitive, "the credential is never echoed back");
    }

    [Fact]
    public async Task One_loud_client_cannot_spend_another_client_s_allowance()
    {
        // The partition, asserted rather than assumed. A global limiter on this route would let
        // one phone in a retry loop silence every other phone's telemetry — and, worse, an
        // admin's browser posts to the same route.
        var limit = App.Factory.Services
            .GetRequiredService<IOptions<LoggingOptions>>().Value.ClientEvents.RateLimitPerMinute;

        using var loud = App.CreateClientWithToken("trn_d_not-a-real-token-noisy");

        for (var i = 0; i <= limit; i++)
        {
            (await loud.PostJson("/api/client-events", Batch(Event()))).Dispose();
        }

        (await loud.PostJson("/api/client-events", Batch(Event()))).StatusCode
            .ShouldBe(HttpStatusCode.TooManyRequests, "the arrange did not exhaust the window");

        // The ordinary caller, entirely unaffected — and this one is the real device token, so it
        // proves the route still works rather than merely that it answers something.
        var quiet = await Client.PostJson("/api/client-events", Batch(Event()));

        quiet.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        (await quiet.JsonAsync()).GetProperty("accepted").GetInt32().ShouldBe(1);
    }
}
