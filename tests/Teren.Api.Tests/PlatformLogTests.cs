using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// <c>GET /api/platform/logs</c> and its CSV twin (D5).
///
/// <para>
/// The two routes take the same query parameters by contract, because the promise the screen makes
/// is "download what you are looking at". Several of the assertions here exist to hold that
/// promise rather than to test a filter twice.
/// </para>
/// </summary>
public sealed class PlatformLogTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>A fixed instant, so paging assertions are about ordering and not about how fast
    /// the test ran.</summary>
    private static readonly DateTime Base =
        new(2026, 9, 2, 12, 0, 0, DateTimeKind.Utc);

    private async Task<List<long>> GivenLogsAsync(params AppLog[] rows)
    {
        await using var identity = App.CreateIdentityDbContext();
        identity.Logs.AddRange(rows);
        await identity.SaveChangesAsync(Ct);

        return [.. rows.Select(r => r.Id)];
    }

    private static AppLog Line(
        int minute,
        string level = AppLogLevels.Information,
        string source = "Teren.Infrastructure.Reporting.EntryReporter",
        string message = "Report sent",
        string? template = null,
        Guid? companyId = null,
        Guid? entryId = null,
        string? properties = null,
        string? exception = null,
        string? correlation = null) => new()
        {
            At = Base.AddMinutes(minute),
            Level = level,
            Source = source,
            Template = template ?? message,
            Message = message,
            Properties = properties,
            Exception = exception,
            CompanyId = companyId,
            EntryId = entryId,
            Correlation = correlation,
        };

    // ------------------------------------------------------------------------------ the gate

    [Theory]
    [InlineData("/api/platform/logs")]
    [InlineData("/api/platform/logs/export")]
    public async Task A_company_admin_is_refused_and_a_foreman_is_refused(string route)
    {
        // 403 and not 404: whether a caller may read the log stream depends only on his role and
        // on no row at all, so it is a question about capability. A 404 would be the one place in
        // the product where "not found" meant "you may not".
        using var customer = await GivenCompanyAdminClientAsync();

        (await customer.Get(route)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await Client.Get(route)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task An_anonymous_caller_gets_401_before_403()
    {
        using var anonymous = App.CreateAnonymousClient();

        (await anonymous.Get("/api/platform/logs")).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
    }

    // ------------------------------------------------------------------------------ the page

    [Fact]
    public async Task The_stream_comes_back_newest_first_with_the_id_as_a_string()
    {
        await GivenLogsAsync(Line(0, message: "oldest"), Line(5, message: "newest"));

        using var staff = await GivenSuperAdminClientAsync();
        var body = await (await staff.Get("/api/platform/logs")).JsonAsync();

        var logs = body.GetProperty("logs").EnumerateArray().ToList();
        logs.Count.ShouldBe(2);
        logs[0].GetText("message").ShouldBe("newest");

        // A string on the wire. A bigserial past 2^53 loses precision as a JSON number, and a log
        // id quietly wrong by one is a bug nobody finds.
        logs[0].GetProperty("id").ValueKind.ShouldBe(JsonValueKind.String);
        long.Parse(logs[0].GetText("id"), CultureInfo.InvariantCulture).ShouldBeGreaterThan(0);

        body.IsNull("next_cursor").ShouldBeTrue("two rows is not a full page");
    }

    [Fact]
    public async Task The_cursor_walks_the_whole_stream_exactly_once()
    {
        // The property keyset paging exists for: every row seen once, in order, with no repeats.
        await GivenLogsAsync([.. Enumerable.Range(0, 7).Select(i => Line(i, message: $"line {i}"))]);

        using var staff = await GivenSuperAdminClientAsync();

        var seen = new List<string>();
        string? cursor = null;

        for (var page = 0; page < 10; page++)
        {
            var url = "/api/platform/logs?limit=3"
                + (cursor is null ? string.Empty : $"&cursor={Uri.EscapeDataString(cursor)}");

            var body = await (await staff.Get(url)).JsonAsync();
            seen.AddRange(body.GetProperty("logs").EnumerateArray().Select(l => l.GetText("message")));

            if (body.IsNull("next_cursor"))
            {
                break;
            }

            cursor = body.GetText("next_cursor");
        }

        seen.ShouldBe(["line 6", "line 5", "line 4", "line 3", "line 2", "line 1", "line 0"]);
    }

    [Fact]
    public async Task Rows_sharing_an_instant_are_separated_by_id_rather_than_skipped()
    {
        // A flush writes a batch in one round trip, so `at` ties are the ordinary case, not an
        // edge one. Without the id in the keyset this page would either repeat or lose rows.
        await GivenLogsAsync(
            [.. Enumerable.Range(0, 5).Select(i => Line(0, message: $"tied {i}"))]);

        using var staff = await GivenSuperAdminClientAsync();

        var first = await (await staff.Get("/api/platform/logs?limit=2")).JsonAsync();
        var cursor = first.GetText("next_cursor");
        var second = await (await staff.Get(
            $"/api/platform/logs?limit=2&cursor={Uri.EscapeDataString(cursor)}")).JsonAsync();

        var firstIds = first.GetProperty("logs").EnumerateArray()
            .Select(l => l.GetText("id")).ToList();
        var secondIds = second.GetProperty("logs").EnumerateArray()
            .Select(l => l.GetText("id")).ToList();

        firstIds.Count.ShouldBe(2);
        secondIds.Count.ShouldBe(2);
        firstIds.Intersect(secondIds, StringComparer.Ordinal).ShouldBeEmpty();
    }

    [Fact]
    public async Task A_malformed_cursor_is_a_400_and_never_a_silent_first_page()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.Get("/api/platform/logs?cursor=not-a-cursor");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.ProblemDetailAsync()).ShouldContain("cursor");
    }

    // ------------------------------------------------------------------------------ filters

    [Fact]
    public async Task Levels_are_repeatable_and_comma_separated_and_an_unknown_one_is_refused()
    {
        await GivenLogsAsync(
            Line(0, AppLogLevels.Information, message: "info"),
            Line(1, AppLogLevels.Warning, message: "warn"),
            Line(2, AppLogLevels.Error, message: "err"));

        using var staff = await GivenSuperAdminClientAsync();

        var repeated = await (await staff.Get(
            "/api/platform/logs?level=Warning&level=Error")).JsonAsync();
        repeated.GetProperty("logs").GetArrayLength().ShouldBe(2);

        // Case-insensitive in, canonical out: a filter comparing "error" against a column holding
        // "Error" would answer "no such lines" for the level an operator most wants.
        var commaSeparated = await (await staff.Get(
            "/api/platform/logs?level=warning,error")).JsonAsync();
        commaSeparated.GetProperty("logs").GetArrayLength().ShouldBe(2);

        var unknown = await staff.Get("/api/platform/logs?level=Panic");
        unknown.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await unknown.ProblemDetailAsync()).ShouldContain("Panic");
    }

    [Fact]
    public async Task Source_is_a_case_insensitive_contains()
    {
        await GivenLogsAsync(
            Line(0, source: "Teren.Infrastructure.Reporting.EntryReporter", message: "a"),
            Line(1, source: "web.capture", message: "b"));

        using var staff = await GivenSuperAdminClientAsync();

        var body = await (await staff.Get("/api/platform/logs?source=REPORTING")).JsonAsync();

        body.GetProperty("logs").GetArrayLength().ShouldBe(1);
        body.GetProperty("logs")[0].GetText("message").ShouldBe("a");
    }

    [Fact]
    public async Task Free_text_searches_the_message_and_the_template_and_nothing_else()
    {
        // The rule that matters: never `properties`, never `exception`. An operator searching for
        // a word must not be able to fish through stack traces for it.
        await GivenLogsAsync(
            Line(0, message: "delivery failed", template: "delivery failed"),
            Line(1, message: "nothing", template: "kotlarnica {Count}"),
            Line(2, message: "nothing at all", properties: """{"Reason":"kotlarnica"}"""),
            Line(3, message: "still nothing", exception: "System.Exception: kotlarnica"));

        using var staff = await GivenSuperAdminClientAsync();

        var body = await (await staff.Get("/api/platform/logs?q=KOTLARNICA")).JsonAsync();

        var messages = body.GetProperty("logs").EnumerateArray()
            .Select(l => l.GetText("message")).ToList();

        messages.ShouldBe(["nothing"]);
    }

    [Fact]
    public async Task The_window_is_inclusive_at_the_start_and_exclusive_at_the_end()
    {
        // So two adjacent windows neither overlap nor drop a row between them.
        await GivenLogsAsync(
            Line(0, message: "at from"),
            Line(5, message: "inside"),
            Line(10, message: "at to"));

        using var staff = await GivenSuperAdminClientAsync();

        var from = Base.ToString("O", CultureInfo.InvariantCulture);
        var to = Base.AddMinutes(10).ToString("O", CultureInfo.InvariantCulture);

        var body = await (await staff.Get(
            $"/api/platform/logs?from={Uri.EscapeDataString(from)}&to={Uri.EscapeDataString(to)}"))
            .JsonAsync();

        body.GetProperty("logs").EnumerateArray().Select(l => l.GetText("message"))
            .ShouldBe(["inside", "at from"]);
    }

    [Fact]
    public async Task An_unparseable_instant_is_a_400_rather_than_an_ignored_filter()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.Get("/api/platform/logs?from=yesterday");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.ProblemDetailAsync()).ShouldContain("ISO-8601");
    }

    [Fact]
    public async Task The_company_and_entry_filters_narrow_to_one_row_each()
    {
        var entryId = Guid.NewGuid();

        await GivenLogsAsync(
            Line(0, message: "company A", companyId: TestIds.CompanyA),
            Line(1, message: "company B", companyId: TestIds.CompanyB),
            Line(2, message: "one entry", entryId: entryId));

        using var staff = await GivenSuperAdminClientAsync();

        var byCompany = await (await staff.Get(
            $"/api/platform/logs?company_id={TestIds.CompanyB}")).JsonAsync();
        byCompany.GetProperty("logs").GetArrayLength().ShouldBe(1);
        byCompany.GetProperty("logs")[0].GetText("message").ShouldBe("company B");

        var byEntry = await (await staff.Get(
            $"/api/platform/logs?entry_id={entryId}")).JsonAsync();
        byEntry.GetProperty("logs").GetArrayLength().ShouldBe(1);
        byEntry.GetProperty("logs")[0].GetText("message").ShouldBe("one entry");
    }

    // ------------------------------------------------------------------------------ the export

    [Fact]
    public async Task The_export_is_csv_with_a_bom_a_filename_and_the_contracted_columns()
    {
        await GivenLogsAsync(Line(0, message: "Otkazano čišćenje", correlation: "abc"));

        using var staff = await GivenSuperAdminClientAsync();
        var response = await staff.Get("/api/platform/logs/export");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.ToString().ShouldBe("text/csv; charset=utf-8");
        response.Content.Headers.ContentDisposition!.ToString()
            .ShouldStartWith("attachment; filename=\"teren-logs-");

        var bytes = await response.Content.ReadAsByteArrayAsync(Ct);

        // The BOM. Without those three bytes Excel reads this as the system code page and every
        // Serbian letter in it is mojibake — and the founder opens this in Excel.
        bytes[0].ShouldBe((byte)0xEF);
        bytes[1].ShouldBe((byte)0xBB);
        bytes[2].ShouldBe((byte)0xBF);

        var text = Encoding.UTF8.GetString(bytes);
        var lines = text.TrimEnd('\r', '\n').Split("\r\n");

        lines[0].TrimStart('﻿').ShouldBe(
            "at,level,source,message,template,company_id,entry_id,correlation,properties,exception");
        lines[1].ShouldContain("Otkazano čišćenje");
        lines[1].ShouldContain("abc");
    }

    [Fact]
    public async Task The_export_obeys_the_same_filters_as_the_page()
    {
        // The whole point of one LogQuery: what he downloads is what he is looking at.
        await GivenLogsAsync(
            Line(0, AppLogLevels.Error, message: "boom"),
            Line(1, AppLogLevels.Information, message: "fine"));

        using var staff = await GivenSuperAdminClientAsync();

        var csv = await (await staff.Get("/api/platform/logs/export?level=Error")).TextAsync();

        csv.ShouldContain("boom");
        csv.ShouldNotContain("fine");
    }

    [Fact]
    public async Task A_field_with_a_comma_or_a_newline_is_quoted_and_a_formula_is_defused()
    {
        await GivenLogsAsync(
            Line(0, message: "one, two", exception: "System.Exception: x\n   at Y()"),
            Line(1, message: "=1+1"));

        using var staff = await GivenSuperAdminClientAsync();
        var csv = await (await staff.Get("/api/platform/logs/export")).TextAsync();

        csv.ShouldContain("\"one, two\"");
        csv.ShouldContain("\"System.Exception: x\n   at Y()\"");

        // A leading '=' would be executed as a formula the moment the file is opened. Nothing in
        // this table is attacker-controlled today; the point of the ingest route is that it might
        // be tomorrow.
        csv.ShouldContain("'=1+1");
    }

    [Fact]
    public async Task An_export_of_nothing_is_a_header_row_and_not_an_error()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var csv = await (await staff.Get("/api/platform/logs/export?level=Fatal")).TextAsync();

        csv.TrimStart('﻿').TrimEnd('\r', '\n').ShouldBe(
            "at,level,source,message,template,company_id,entry_id,correlation,properties,exception");
    }

    // ------------------------------------------------------------------------------ the sink

    [Fact]
    public async Task A_refused_request_lands_in_the_table_through_the_real_sink()
    {
        // End to end through the shipped wiring: RoleFilter logs a warning, Serilog hands it to
        // PostgresLogSink, the queue holds it, the writer inserts it, and the viewer reads it.
        // Nothing here is a double.
        using var customer = await GivenCompanyAdminClientAsync();
        (await customer.Get("/api/platform/logs")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        (await App.FlushLogsAsync(Ct)).ShouldBeGreaterThan(0);

        using var staff = await GivenSuperAdminClientAsync();
        var body = await (await staff.Get(
            "/api/platform/logs?source=RoleFilter&level=Warning")).JsonAsync();

        var logs = body.GetProperty("logs").EnumerateArray().ToList();
        logs.ShouldNotBeEmpty();

        var line = logs[0];
        line.GetText("source").ShouldBe("Teren.Api.Auth.RoleFilter");
        line.GetText("message").ShouldContain("company_admin");
        line.GetText("template").ShouldContain("{Role}");

        // Inline JSON, not a quoted string: a client must not have to JSON.parse a field of a
        // JSON document to read a property.
        var properties = line.GetProperty("properties");
        properties.ValueKind.ShouldBe(JsonValueKind.Object);
        properties.GetText("Role").ShouldBe("company_admin");
        properties.GetText("Method").ShouldBe("GET");
    }

    [Fact]
    public async Task The_table_is_the_one_the_identity_model_owns()
    {
        // app_log lives in TerenIdentityDbContext, which is what keeps the log viewer on the
        // super-admin-safe side of the two-context split. Asserted here as well as in
        // IdentityModelTests because this is the screen that would have been the reason to move it.
        await using var identity = App.CreateIdentityDbContext();

        await identity.Logs.CountAsync(Ct);

        await using var evidence = App.CreateDbContext(TestIds.CompanyA);
        Should.Throw<InvalidOperationException>(() => evidence.Set<AppLog>().FirstOrDefault());
    }
}
