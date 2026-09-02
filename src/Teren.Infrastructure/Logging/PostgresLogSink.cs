using System.Globalization;
using System.IO;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Serilog.Core;
using Serilog.Events;
using Serilog.Parsing;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// The Serilog sink that fills <c>app_log</c> — and, more to the point, the place where the
/// product's logging discipline stops being a convention (plan §12).
///
/// <para>
/// <b>Three things happen here and nowhere else.</b> A property that is not on
/// <see cref="LogProperties"/> is dropped rather than stored. An exception is reduced to its type
/// chain, an allow-listed message and a truncated stack (<see cref="LogScrubbing"/>). And the
/// rendered message is built from the surviving properties only, so a dropped one leaves its
/// placeholder in the text instead of leaving a fact there.
/// </para>
///
/// <para>
/// <b><see cref="Emit"/> does no I/O.</b> It builds a row and hands it to
/// <see cref="AppLogQueue"/>. That is what keeps the non-negotiable true from the logging side as
/// well as the request side: nothing a foreman's phone triggers can wait on this table, and a
/// database that is down costs log lines rather than requests. It also never throws — a sink that
/// threw would surface as a 500 on whatever happened to be logging.
/// </para>
///
/// <para>
/// <b>Verbose and Debug are dropped outside Development.</b> The console keeps them; this table
/// does not. <c>app_log</c> is a firehose on a small VPS, and debug-level rows are the difference
/// between a log that is retained for a fortnight and a log that is the largest thing in the
/// nightly backup.
/// </para>
/// </summary>
public sealed class PostgresLogSink(
    AppLogQueue queue, IOptions<LoggingOptions> options, bool storeDebugLevels) : ILogEventSink
{
    /// <summary>What <c>source</c> says when Serilog gave us no <c>SourceContext</c> — a line
    /// logged through a bare <c>ILoggerFactory.CreateLogger("…")</c> category, or from the
    /// framework. Never empty: the column is NOT NULL and an empty cell in a viewer reads as a
    /// rendering bug.</summary>
    public const string UnknownSource = "(no source)";

    private readonly bool _enabled = options.Value.Enabled;

    public void Emit(LogEvent logEvent)
    {
        if (!_enabled || logEvent is null)
        {
            return;
        }

        if (!storeDebugLevels
            && logEvent.Level is LogEventLevel.Verbose or LogEventLevel.Debug)
        {
            return;
        }

        try
        {
            queue.Enqueue(ToRow(logEvent));
        }
        catch (Exception ex)
        {
            // Deliberately swallowed and deliberately not logged: a sink that throws takes down
            // the call that was logging, and a sink that logs about itself recurses.
            Serilog.Debugging.SelfLog.WriteLine("app_log: a log event was dropped: {0}", ex.Message);
        }
    }

    /// <summary>
    /// The two templates <c>Serilog.Extensions.Logging</c> invents for a
    /// <c>Microsoft.Extensions.Logging</c> event whose state is already a formatted string: the
    /// text goes into a property and the "template" is nothing but its placeholder.
    ///
    /// <para>
    /// <b>Every third-party library in this process logs that way</b>, Hangfire included — which
    /// is the one source "what is failing" most needs. Rendered naively, the property is not
    /// allow-listed (correctly: it is free text nobody here wrote), so the row arrived as the
    /// literal <c>{State:l}</c> and nothing else. Over half of the dev table was that, and a job
    /// failure read as a placeholder with a scrubbed exception type beside it.
    /// </para>
    /// </summary>
    private static readonly (string Template, string Property)[] PreRendered =
    [
        ("{State:l}", "State"),
        ("{Message:l}", "Message"),
    ];

    private static AppLogRow ToRow(LogEvent logEvent)
    {
        var properties = logEvent.Properties;

        return new AppLogRow(
            At: logEvent.Timestamp.UtcDateTime,
            Level: logEvent.Level.ToString(),
            Source: Scalar(properties, LogProperties.SourceContext) as string ?? UnknownSource,
            Template: LogScrubbing.Text(logEvent.MessageTemplate.Text),
            Message: Message(logEvent),
            Properties: Bag(properties),
            Exception: LogScrubbing.Describe(logEvent.Exception),
            CompanyId: Uuid(properties, LogProperties.CompanyId),
            EntryId: Uuid(properties, LogProperties.EntryId),
            Correlation: Scalar(properties, LogProperties.Correlation) as string);
    }

    /// <summary>
    /// What goes in the <c>message</c> column.
    ///
    /// <para>
    /// Ordinarily <see cref="Render"/>, from allow-listed properties only. The exception is a
    /// pre-rendered framework line (<see cref="PreRendered"/>), where the template is a
    /// placeholder and the words are the property: there, the words <em>are</em> the message, so
    /// they are stored as third-party text — capped and address-scrubbed, exactly as an
    /// allow-listed exception message is. The property still never reaches the JSON bag, so the
    /// text is stored once and only where a reader looks for it.
    /// </para>
    /// </summary>
    private static string Message(LogEvent logEvent)
    {
        foreach (var (template, property) in PreRendered)
        {
            if (logEvent.MessageTemplate.Text == template
                && Scalar(logEvent.Properties, property) is string text)
            {
                return LogScrubbing.ThirdPartyText(text);
            }
        }

        return LogScrubbing.Text(Render(logEvent));
    }

    /// <summary>
    /// The message, rendered from allow-listed properties only.
    /// <para>
    /// A dropped property is written back as its own placeholder — <c>{Email}</c> stays
    /// <c>{Email}</c> — rather than as a blank or a marker word. That reads as an omission in a
    /// way an empty gap does not, and it keeps the rendered line aligned with the
    /// <c>template</c> column beside it, which is what an operator compares when he wonders why a
    /// line looks incomplete.
    /// </para>
    /// </summary>
    private static string Render(LogEvent logEvent)
    {
        var writer = new StringWriter(CultureInfo.InvariantCulture);

        foreach (var token in logEvent.MessageTemplate.Tokens)
        {
            if (token is PropertyToken property && !Storable(property.PropertyName))
            {
                writer.Write(property.ToString());
                continue;
            }

            token.Render(logEvent.Properties, writer, CultureInfo.InvariantCulture);
        }

        return writer.ToString();
    }

    /// <summary>A property is storable when it is allow-listed, or when it has a column of its own
    /// (in which case it is already part of the row and rendering it is not a disclosure).</summary>
    private static bool Storable(string name) =>
        LogProperties.IsAllowed(name) || LogProperties.IsColumn(name);

    /// <summary>
    /// The JSONB bag: allow-listed properties only, with the four that have their own columns left
    /// out so the row does not say the same thing twice.
    /// </summary>
    private static string? Bag(IReadOnlyDictionary<string, LogEventPropertyValue> properties)
    {
        var kept = properties
            .Where(p => LogProperties.IsAllowed(p.Key) && !LogProperties.IsColumn(p.Key))
            .ToList();

        if (kept.Count == 0)
        {
            return null;
        }

        var buffer = new System.Buffers.ArrayBufferWriter<byte>();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();

            foreach (var (name, value) in kept)
            {
                json.WritePropertyName(name);
                Write(json, value);
            }

            json.WriteEndObject();
        }

        return System.Text.Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    /// <summary>
    /// Scalars keep their JSON type — a count must arrive at the viewer as a number, not as
    /// <c>"3"</c>, or every filter and every chart over it has to guess. Anything structured is
    /// rendered to its string form and scrubbed: a destructured object in a log line is exactly
    /// the shape that could carry a customer's work, and the allow-list is by name, so it cannot
    /// see inside one.
    /// </summary>
    private static void Write(Utf8JsonWriter json, LogEventPropertyValue value)
    {
        if (value is not ScalarValue scalar)
        {
            json.WriteStringValue(LogScrubbing.Text(value.ToString()));
            return;
        }

        switch (scalar.Value)
        {
            case null:
                json.WriteNullValue();
                break;
            case bool b:
                json.WriteBooleanValue(b);
                break;
            case sbyte or byte or short or ushort or int or uint or long:
                json.WriteNumberValue(Convert.ToInt64(scalar.Value, CultureInfo.InvariantCulture));
                break;
            case ulong u:
                json.WriteNumberValue(u);
                break;
            case float or double or decimal:
                json.WriteNumberValue(
                    Convert.ToDecimal(scalar.Value, CultureInfo.InvariantCulture));
                break;
            case string s:
                json.WriteStringValue(LogScrubbing.Text(s));
                break;
            // Round-trip, not the invariant culture's "09/02/2026 18:59:32" — which is what
            // Convert.ToString gives, is ambiguous between two continents, and is unsortable.
            case DateTime d:
                json.WriteStringValue(d.ToString("O", CultureInfo.InvariantCulture));
                break;
            case DateTimeOffset o:
                json.WriteStringValue(o.ToString("O", CultureInfo.InvariantCulture));
                break;
            default:
                json.WriteStringValue(LogScrubbing.Text(
                    Convert.ToString(scalar.Value, CultureInfo.InvariantCulture)));
                break;
        }
    }

    private static object? Scalar(
        IReadOnlyDictionary<string, LogEventPropertyValue> properties, string name) =>
        properties.TryGetValue(name, out var value) && value is ScalarValue scalar
            ? scalar.Value
            : null;

    /// <summary>
    /// The two id columns, taken from the log scope. Accepts a real <see cref="Guid"/> and a
    /// string that parses as one, because a scope pushed by <c>BeginScope</c> and a property
    /// captured from a template do not always arrive the same way.
    /// </summary>
    private static Guid? Uuid(
        IReadOnlyDictionary<string, LogEventPropertyValue> properties, string name) =>
        Scalar(properties, name) switch
        {
            Guid id => id,
            string text when Guid.TryParse(text, out var parsed) => parsed,
            _ => null,
        };
}
