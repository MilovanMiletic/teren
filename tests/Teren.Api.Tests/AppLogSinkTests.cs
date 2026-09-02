using System.Text.Json;
using Microsoft.Extensions.Options;
using Serilog;
using Serilog.Events;
using Teren.Core.Ai;
using Teren.Core.Entities;
using Teren.Infrastructure.Logging;

namespace Teren.Api.Tests;

/// <summary>
/// The sink, on its own: what it stores, what it refuses, and what it never waits for.
///
/// <para>
/// Driven through a real <see cref="Serilog.Core.Logger"/> rather than by hand-building
/// <see cref="LogEvent"/>s, because the thing under test is what happens to an ordinary
/// <c>logger.LogWarning(ex, "…{Thing}…", value)</c> — template parsing, property capture and
/// destructuring included. A hand-built event would prove the sink handles events the test knows
/// how to build.
/// </para>
/// </summary>
public sealed class AppLogSinkTests
{
    private static readonly LoggingOptions Options = new();

    /// <summary>A sink and the queue it feeds, wired the way the application wires them.</summary>
    private static (ILogger Logger, AppLogQueue Queue) Rig(bool storeDebugLevels = true)
    {
        var queue = new AppLogQueue(Microsoft.Extensions.Options.Options.Create(Options));
        var sink = new PostgresLogSink(
            queue, Microsoft.Extensions.Options.Options.Create(Options), storeDebugLevels);

        var logger = new LoggerConfiguration()
            .MinimumLevel.Verbose()
            .WriteTo.Sink(sink)
            .CreateLogger();

        return (logger, queue);
    }

    private static AppLogRow Single(AppLogQueue queue)
    {
        var rows = queue.Take(10);
        rows.Count.ShouldBe(1);
        return rows[0];
    }

    // ------------------------------------------------------------------ the property allow-list

    [Fact]
    public void An_allow_listed_property_is_stored_with_its_json_type()
    {
        var (logger, queue) = Rig();

        logger.Information(
            "Report {ReportId} delivery failed after {Attempt} attempts", "abc", 3);

        var row = Single(queue);

        using var properties = JsonDocument.Parse(row.Properties!);
        properties.RootElement.GetProperty("ReportId").GetString().ShouldBe("abc");

        // A number, not "3". A count that arrives as a string makes every filter and every chart
        // over it guess.
        properties.RootElement.GetProperty("Attempt").ValueKind.ShouldBe(JsonValueKind.Number);
        properties.RootElement.GetProperty("Attempt").GetInt32().ShouldBe(3);
    }

    [Fact]
    public void An_unknown_property_is_dropped_and_the_message_keeps_its_placeholder()
    {
        // THE MUTATION TARGET for enforcement 1. `Whisper` is not on LogProperties, so neither
        // the bag nor the rendered message may carry the value.
        var (logger, queue) = Rig();

        logger.Information(
            "Entry {EntryId} said {Whisper}", Guid.NewGuid(), "danas smo zavrsili kupatilo");

        var row = Single(queue);

        row.Properties.ShouldBeNull("EntryId has its own column and Whisper is not allow-listed");
        row.Message.ShouldNotContain("kupatilo");
        row.Message.ShouldContain("{Whisper}");

        // The template is stored unrendered, so a reader can see exactly which property was
        // dropped rather than wondering whether the line was truncated.
        row.Template.ShouldBe("Entry {EntryId} said {Whisper}");
    }

    [Fact]
    public void The_columns_are_lifted_out_of_the_property_bag()
    {
        var entryId = Guid.NewGuid();
        var companyId = Guid.NewGuid();
        var (logger, queue) = Rig();

        logger
            .ForContext("SourceContext", "Teren.Infrastructure.Reporting.EntryReporter")
            .ForContext("EntryId", entryId)
            .ForContext("CompanyId", companyId)
            .ForContext("Correlation", "sweep-7")
            .Warning("Entry {EntryId}: {Photos} photo(s) missing", entryId, 2);

        var row = Single(queue);

        row.Source.ShouldBe("Teren.Infrastructure.Reporting.EntryReporter");
        row.EntryId.ShouldBe(entryId);
        row.CompanyId.ShouldBe(companyId);
        row.Correlation.ShouldBe("sweep-7");
        row.Level.ShouldBe(AppLogLevels.Warning);

        // Not repeated in the bag: the row would otherwise say the same thing twice, and the
        // viewer would have two places to disagree about one id.
        using var properties = JsonDocument.Parse(row.Properties!);
        properties.RootElement.TryGetProperty("EntryId", out _).ShouldBeFalse();
        properties.RootElement.GetProperty("Photos").GetInt32().ShouldBe(2);
    }

    [Fact]
    public void A_line_with_no_source_context_still_names_something()
    {
        var (logger, queue) = Rig();

        logger.Information("Nothing in particular");

        // NOT NULL in the schema, and an empty cell in a viewer reads as a rendering bug rather
        // than as "the framework logged this".
        Single(queue).Source.ShouldBe(PostgresLogSink.UnknownSource);
    }

    [Fact]
    public void A_destructured_object_is_flattened_and_never_stored_as_structure()
    {
        // The allow-list works on names and cannot see inside an object. Anything that is not a
        // scalar is rendered to a string and scrubbed, so a destructured payload cannot smuggle a
        // shape into the JSONB column.
        var (logger, queue) = Rig();

        logger.Information("Sent to {Recipients}", new { Total = 2 });

        using var properties = JsonDocument.Parse(Single(queue).Properties!);
        properties.RootElement.GetProperty("Recipients").ValueKind.ShouldBe(JsonValueKind.String);
    }

    // ------------------------------------------------------------------ levels

    [Theory]
    [InlineData(LogEventLevel.Verbose)]
    [InlineData(LogEventLevel.Debug)]
    public void Verbose_and_debug_are_dropped_outside_development(LogEventLevel level)
    {
        var (logger, queue) = Rig(storeDebugLevels: false);

        logger.Write(level, "Chatter {Count}", 1);

        queue.Count.ShouldBe(0);
    }

    [Fact]
    public void Verbose_and_debug_are_kept_in_development()
    {
        var (logger, queue) = Rig(storeDebugLevels: true);

        logger.Debug("Chatter {Count}", 1);

        Single(queue).Level.ShouldBe(AppLogLevels.Debug);
    }

    [Fact]
    public void Every_level_name_the_sink_writes_is_one_the_check_constraint_admits()
    {
        // The C# enum, the CHECK constraint and the ?level= filter are three places that have to
        // agree. If Serilog ever renamed one, every row at that level would be rejected by the
        // database inside a background flush — where nobody would see it.
        foreach (var level in Enum.GetValues<LogEventLevel>())
        {
            AppLogLevels.All.ShouldContain(level.ToString());
        }
    }

    // ------------------------------------------------------------------ exception scrubbing

    [Fact]
    public void A_third_party_exception_message_is_withheld_and_its_type_and_stack_kept()
    {
        // THE MUTATION TARGET for enforcement 2, in the exact shape the plan names: BoundedRetry
        // calls LogWarning(ex, …), and an Anthropic or Azure exception can echo the request back.
        // Here the "provider" exception is AiProviderException, which is OURS and still refused —
        // ClaudeStructureExtractor builds its message as "the model API rejected the request:
        // {ex.Message}", so "our type, therefore safe" is false.
        var (logger, queue) = Rig();

        var provider = new AiProviderException(
            "anthropic",
            "the model API rejected the request: input was "
            + "\"danas smo zavrsili kupatilo na drugom spratu\"",
            retryable: false);

        logger.Warning(provider, "{Operation} attempt {Attempt} failed", "extract", 1);

        var row = Single(queue);

        var exception = row.Exception.ShouldNotBeNull();
        exception.ShouldNotContain("kupatilo");
        exception.ShouldContain("Teren.Core.Ai.AiProviderException");
        exception.ShouldContain(LogScrubbing.WithheldMessage);
    }

    [Fact]
    public void An_allow_listed_exception_keeps_its_message()
    {
        // The contract's own example — "SocketException: Connection refused" — is the line an
        // operator actually needs. Withholding every message would make the viewer useless in the
        // name of safety, which is its own kind of failure.
        var (logger, queue) = Rig();

        logger.Error(new TimeoutException("the operation timed out"), "{Operation} gave up", "send");

        var row = Single(queue);

        var exception = row.Exception.ShouldNotBeNull();
        exception.ShouldContain("System.TimeoutException");
        exception.ShouldContain("the operation timed out");
    }

    [Fact]
    public void An_address_inside_an_allow_listed_exception_is_redacted()
    {
        // The one thing that arrives from outside our own call sites: a relay's own answer.
        // ARCHITECTURE §12 keeps personal data out of logs regardless of who put it there.
        var (logger, queue) = Rig();

        logger.Error(
            new TimeoutException("250 2.1.5 Ok <dragan.obradovic@example.com> timed out"),
            "{Transport} gave up",
            "smtp");

        var row = Single(queue);

        var exception = row.Exception.ShouldNotBeNull();
        exception.ShouldNotContain("dragan.obradovic@example.com");
        exception.ShouldContain(LogScrubbing.RedactedAddress);
    }

    [Fact]
    public void An_address_in_an_allow_listed_property_value_is_redacted_too()
    {
        // `Response` is allow-listed because the relay's own words are worth having; some relays
        // echo the recipient in them. The name allow-list cannot see that, so the value scrub does.
        var (logger, queue) = Rig();

        logger.Information(
            "Mail handed to the relay: {Response}", "250 Ok queued for jelena.markovic@example.com");

        var row = Single(queue);

        row.Message.ShouldNotContain("jelena.markovic@example.com");
        row.Properties.ShouldNotBeNull().ShouldNotContain("jelena.markovic@example.com");
    }

    [Fact]
    public void A_withheld_message_still_names_the_inner_type()
    {
        var (logger, queue) = Rig();

        logger.Error(
            new InvalidOperationException("outer", new AiProviderException("azure", "inner", false)),
            "{Operation} failed",
            "transcribe");

        var row = Single(queue);

        var exception = row.Exception.ShouldNotBeNull();
        exception.ShouldContain("System.InvalidOperationException");
        exception.ShouldContain("Teren.Core.Ai.AiProviderException");
        exception.ShouldNotContain("outer");
        exception.ShouldNotContain("inner");
    }

    [Fact]
    public void A_very_long_allow_listed_message_is_truncated()
    {
        var (logger, queue) = Rig();

        logger.Error(new TimeoutException(new string('x', 5_000)), "{Operation} failed", "send");

        var row = Single(queue);

        row.Exception!.Length.ShouldBeLessThan(LogScrubbing.MaxExceptionMessage + 200);
        row.Exception.ShouldContain("truncated");
    }

    // ------------------------------------------------------------------ the queue

    [Fact]
    public void Emitting_never_throws_and_never_waits()
    {
        // The non-negotiable, stated as a test: a log call is an enqueue and nothing else. There
        // is no connection string in this rig at all, so if Emit touched a database it could only
        // fail — and it must not.
        var queue = new AppLogQueue(Microsoft.Extensions.Options.Options.Create(Options));
        var sink = new PostgresLogSink(
            queue, Microsoft.Extensions.Options.Options.Create(Options), storeDebugLevels: true);

        Should.NotThrow(() => sink.Emit(null!));

        var logger = new LoggerConfiguration()
            .MinimumLevel.Verbose().WriteTo.Sink(sink).CreateLogger();

        Should.NotThrow(() => logger.Information("Nothing {Count}", 1));
        queue.Count.ShouldBe(1);
    }

    [Fact]
    public void A_full_queue_drops_the_oldest_and_counts_what_it_dropped()
    {
        // Bounded, because an unbounded queue turns a database outage into an out-of-memory kill
        // of a process that was serving foremen perfectly well. Oldest-first, because when the
        // writer is stuck the newest lines are the ones about what is going wrong.
        var options = Microsoft.Extensions.Options.Options.Create(
            new LoggingOptions { QueueCapacity = 100 });

        var queue = new AppLogQueue(options);

        for (var i = 0; i < 150; i++)
        {
            queue.Enqueue(Row(i));
        }

        queue.Count.ShouldBe(100);
        queue.Dropped.ShouldBe(50);

        var kept = queue.Take(1_000);
        kept.Count.ShouldBe(100);

        // The 50 that went are the first 50.
        kept[0].Correlation.ShouldBe("50");
        kept[^1].Correlation.ShouldBe("149");
    }

    private static AppLogRow Row(int index) => new(
        DateTime.UtcNow,
        AppLogLevels.Information,
        "test",
        "t",
        "m",
        null,
        null,
        null,
        null,
        index.ToString(System.Globalization.CultureInfo.InvariantCulture));
}
