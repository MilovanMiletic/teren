using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;
using Serilog;
using Serilog.Debugging;
using Serilog.Extensions.Logging;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Teren.Api.Errors;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Logging;

namespace Teren.Api.Tests;

/// <summary>
/// <b>Who can put words into <c>app_log</c>, and what happens when the table cannot be reached.</b>
/// The three gating findings of the D5 review live here, each as the test the reviewer asked for.
///
/// <para>
/// The increment's central claim is that Teren staff read a log stream that cannot carry a
/// customer's work. That claim is about <em>every</em> writer, and the review found the loudest one
/// was nobody at all: the 401 path runs before any credential is checked, and it logged
/// <c>{Path}</c> — the URL the caller typed. A matched route with a free segment was therefore an
/// anonymous, unauthenticated, ~2 000-character write into the table.
/// </para>
/// </summary>
public sealed class AppLogIngressTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>
    /// A Serbian sentence in the shape a URL segment can carry. Deliberately the reviewer's own
    /// proof string, so the test and the finding are the same experiment.
    /// </summary>
    private const string Sentence = "REVIEW-PROOF-ovo-nije-uuid-nego-recenica-o-kupatilu";

    private async Task<List<AppLogRowText>> StoredLogsAsync()
    {
        await App.FlushLogsAsync(Ct);

        await using var identity = App.CreateIdentityDbContext();

        return await identity.Logs
            .OrderBy(l => l.Id)
            .Select(l => new AppLogRowText(l.Message, l.Template, l.Properties, l.Exception))
            .ToListAsync(Ct);
    }

    private sealed record AppLogRowText(
        string Message, string Template, string? Properties, string? Exception)
    {
        public bool Mentions(string text) =>
            Message.Contains(text, StringComparison.Ordinal)
            || Template.Contains(text, StringComparison.Ordinal)
            || (Properties?.Contains(text, StringComparison.Ordinal) ?? false)
            || (Exception?.Contains(text, StringComparison.Ordinal) ?? false);
    }

    // ------------------------------------------------------- G2: the anonymous write into app_log

    [Fact]
    public async Task An_anonymous_caller_cannot_write_his_own_words_into_the_log()
    {
        // THE MUTATION TARGET for the fix. Put "Path" back on LogProperties, or log
        // http.Request.Path again at any of the three sites, and this goes red.
        using var anonymous = App.CreateAnonymousClient();

        var response = await anonymous.Get($"/api/entries/{Sentence}");
        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        var rows = await StoredLogsAsync();

        // Not vacuous: the refusal must still be logged. The fix is about what the line says, not
        // about whether the 401 path speaks at all — a silent gate would be its own defect.
        rows.ShouldNotBeEmpty("the refused request must still appear in the log stream");

        rows.Where(r => r.Mentions(Sentence)).ShouldBeEmpty(
            "An unauthenticated caller wrote free text into app_log. Every row of that table is "
            + "read by Teren staff on the log viewer, and this one arrived with no credential at "
            + "all: any matched route with a free segment would be a way to push a sentence — or "
            + "two thousand characters of one — into the product's own evidence-free surface.");

        // What replaced it: the route template, which comes from the route table and can never be
        // anything the caller typed.
        rows.ShouldContain(
            r => r.Message.Contains("/api/entries/{id}", StringComparison.Ordinal),
            "the line must still say WHERE the request was refused");
    }

    [Fact]
    public async Task The_malformed_request_handler_stores_nothing_the_caller_typed()
    {
        // The second half of the same hole, and the one that needs no route segment: parameter
        // binding runs BEFORE the auth filter, so this line is reachable with no credential at
        // all, and the framework's message names the value it could not read.
        //
        // Driven against the handler rather than over HTTP, because it logs at Information and the
        // suite runs Serilog at Warning — an end-to-end version would assert the absence of a row
        // that could never have been written, which is the shape of a test that proves nothing.
        // The environment is Development on purpose: that is where the framework's message is
        // deliberately echoed to the CALLER, and it must still not reach the table.
        var (factory, queue) = MelRig();
        using var _ = factory;

        var handler = new MalformedRequestExceptionHandler(
            new AcceptingProblemDetails(),
            new DevelopmentEnvironment(),
            factory.CreateLogger<MalformedRequestExceptionHandler>());

        var http = new DefaultHttpContext();
        http.Request.Method = "GET";
        http.Request.Path = "/api/entries";
        http.Request.QueryString = new QueryString($"?project_id={Sentence}");

        var handled = await handler.TryHandleAsync(
            http,
            new BadHttpRequestException(
                $"Failed to bind parameter \"Nullable<Guid> projectIdSnake\" from \"{Sentence}\".",
                StatusCodes.Status400BadRequest),
            Ct);

        handled.ShouldBeTrue();

        var row = Single(queue);

        row.Message.ShouldNotContain(Sentence);
        row.Template.ShouldNotContain(Sentence);
        (row.Properties ?? string.Empty).ShouldNotContain(Sentence);

        // Still says what happened and what came back — a refusal nobody can read is its own
        // defect.
        row.Message.ShouldContain("400");
    }

    [Fact]
    public void The_two_free_text_property_names_are_off_the_allow_list()
    {
        // Stated separately from the behaviour above because the allow-list is the boundary: a
        // future call site that logs {Path} or {Message} must be dropped by the sink even if
        // nobody remembers this review.
        LogProperties.IsAllowed("Path").ShouldBeFalse(
            "Path was http.Request.Path — the URL the caller typed");

        LogProperties.IsAllowed("Message").ShouldBeFalse(
            "Message was BadHttpRequestException.Message, which echoes the offending value");
    }

    // ----------------------------------------------- G3: the pre-rendered framework line

    [Fact]
    public void A_pre_rendered_framework_line_is_stored_as_its_words()
    {
        // Serilog.Extensions.Logging renders any MEL event whose state is an already-formatted
        // string as the template "{State:l}", with the text in a State property. State is not
        // allow-listed — correctly, it is free text from a third party — so the row used to be a
        // placeholder and nothing else. Hangfire logs exactly this way, which made over half of
        // the dev table read "{State:l}" and a job failure unreadable.
        var (factory, queue) = MelRig();
        using var _ = factory;

        factory.CreateLogger("Hangfire.Server.BackgroundServerProcess").Log(
            LogLevel.Information,
            eventId: 0,
            state: "Server tsrv:1:1a2b3c successfully announced in 12.3 ms",
            exception: null,
            formatter: (s, _) => s);

        var row = Single(queue);

        row.Message.ShouldBe("Server tsrv:1:1a2b3c successfully announced in 12.3 ms");
        row.Message.ShouldNotBe("{State:l}");
        row.Source.ShouldBe("Hangfire.Server.BackgroundServerProcess");
    }

    [Fact]
    public void A_pre_rendered_line_with_no_state_is_stored_as_its_words_too()
    {
        // The sibling shape: state null, formatter present, which Serilog renders as "{Message:l}".
        // One fix, two templates — miss the second and the same placeholder row comes back under a
        // different name.
        var (factory, queue) = MelRig();
        using var _ = factory;

        factory.CreateLogger("Hangfire.Processing").Log<object?>(
            LogLevel.Warning,
            eventId: 0,
            state: null,
            exception: null,
            formatter: (_, _) => "Failed to process the job: retry 1 of 10 in 00:00:16");

        Single(queue).Message
            .ShouldBe("Failed to process the job: retry 1 of 10 in 00:00:16");
    }

    [Fact]
    public void A_pre_rendered_line_is_still_scrubbed()
    {
        // It is third-party text, so it gets the treatment allow-listed exception messages get:
        // capped, and addresses removed. A relay's answer surfacing through a framework logger
        // must not be the one way an address reaches this table.
        var (factory, queue) = MelRig();
        using var _ = factory;

        factory.CreateLogger("Third.Party").Log(
            LogLevel.Error,
            eventId: 0,
            state: "250 2.1.5 Ok <dragan.obradovic@example.com> " + new string('x', 5_000),
            exception: null,
            formatter: (s, _) => s);

        var row = Single(queue);

        row.Message.ShouldNotContain("dragan.obradovic@example.com");
        row.Message.ShouldContain(LogScrubbing.RedactedAddress);
        row.Message.Length.ShouldBeLessThan(LogScrubbing.MaxExceptionMessage + 200);
    }

    // ------------------------------------------------------------- G4: the sink's failure channel

    [Fact]
    public void The_hosts_own_failure_channel_is_on()
    {
        // Every failure path in the sink — a dropped event, a dropped batch, a flush loop that
        // threw, a queue that overflowed — reports to SelfLog and to nothing else, because an
        // ILogger call from inside the log writer would enqueue a row about failing to write rows.
        // With SelfLog at its default (disabled) all four of those are silent everywhere, and the
        // most repeated failure in this repo — a host started without `migrate` — drops every
        // batch on a 42P01 while the viewer simply looks empty.
        //
        // The host under test is the real one: this assertion is about what Program.cs does.
        SelfLogChannel.IsEnabled.ShouldBeTrue(
            "Serilog's SelfLog is off, so every way the app_log sink can fail is silent.");
    }

    [Fact]
    public async Task A_writer_that_cannot_reach_its_table_says_so_on_the_self_log()
    {
        // The 42P01 case, made real rather than argued: the same writer the host runs, pointed at
        // a schema where `app_log` does not exist.
        var builder = new NpgsqlConnectionStringBuilder(App.ApiConnectionString)
        {
            Options = "-c search_path=teren_no_such_schema",
        };

        await using var dataSource = new NpgsqlDataSourceBuilder(builder.ConnectionString).Build();

        var options = Microsoft.Extensions.Options.Options.Create(new LoggingOptions());
        var queue = new AppLogQueue(options);
        queue.Enqueue(new AppLogRow(
            DateTime.UtcNow, AppLogLevels.Information, "test", "t", "m",
            null, null, null, null, null));

        var lines = new List<string>();

        // Restored rather than disabled at the end, and only when it was on: leaving it enabled
        // after this test would make the assertion above pass on a host that never turned it on.
        var wasEnabled = SelfLogChannel.IsEnabled;
        SelfLog.Enable(lines.Add);

        int written;
        try
        {
            written = await new AppLogWriter(queue, dataSource, options).FlushAsync(Ct);
        }
        finally
        {
            SelfLog.Disable();
            if (wasEnabled)
            {
                SelfLogChannel.EnableToStandardError();
            }
        }

        written.ShouldBe(0);
        lines.ShouldNotBeEmpty("a batch was dropped and nothing anywhere said so");
        lines.ShouldContain(l => l.Contains("app_log", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------------------------- helpers

    /// <summary>
    /// The sink behind a real <see cref="SerilogLoggerProvider"/>, which is what the application
    /// runs: every framework and third-party line reaches Serilog through this bridge, and the
    /// bridge is where the pre-rendered shapes are made.
    /// </summary>
    private static (ILoggerFactory Factory, AppLogQueue Queue) MelRig()
    {
        var options = Microsoft.Extensions.Options.Options.Create(new LoggingOptions());
        var queue = new AppLogQueue(options);
        var sink = new PostgresLogSink(queue, options, storeDebugLevels: true);

        var serilog = new LoggerConfiguration()
            .MinimumLevel.Verbose()
            .WriteTo.Sink(sink)
            .CreateLogger();

        var factory = new LoggerFactory();
        factory.AddProvider(new SerilogLoggerProvider(serilog, dispose: true));

        return (factory, queue);
    }

    /// <summary>Writes nothing: this test is about the log line, not the response body.</summary>
    private sealed class AcceptingProblemDetails : IProblemDetailsService
    {
        public ValueTask<bool> TryWriteAsync(ProblemDetailsContext context) =>
            ValueTask.FromResult(true);

        public ValueTask WriteAsync(ProblemDetailsContext context) => ValueTask.CompletedTask;
    }

    /// <summary>The laptop case — where the handler is allowed to tell the caller what it could
    /// not read, and still may not store it.</summary>
    private sealed class DevelopmentEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Development;
        public string ApplicationName { get; set; } = "Teren.Api";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;

        public IFileProvider ContentRootFileProvider { get; set; } =
            new NullFileProvider();
    }

    private static AppLogRow Single(AppLogQueue queue)
    {
        var rows = queue.Take(10);
        rows.Count.ShouldBe(1);
        return rows[0];
    }
}
