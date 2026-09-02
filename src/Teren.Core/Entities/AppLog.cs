namespace Teren.Core.Entities;

/// <summary>
/// One line of the application's own log, kept where a super admin can read it (plan §12,
/// decision 12).
///
/// <para>
/// <b>This table is the reason the logging discipline stopped being a convention.</b> Until the
/// viewer existed, "no personal data in logs" (ARCHITECTURE §12) was a habit that cost nothing to
/// break: a stray transcript in a log line was written to a console nobody kept. Shipping a screen
/// that shows these rows to Teren staff turns the same habit into a security boundary, which is
/// why the sink that fills this table drops any property it was not told about by name, refuses to
/// store the message of an exception type it does not recognise, and is backed by a test that
/// reads every log call site under <c>src/</c>.
/// </para>
///
/// <para>
/// <b>It lives in <see cref="T:Teren.Infrastructure.Persistence.TerenIdentityDbContext"/> and not
/// in the evidence model</b> (plan §6). That is what keeps the log viewer on the
/// super-admin-safe side of the two-context split: a screen reading these rows never touches a
/// context that has an <c>Entry</c> in it.
/// </para>
///
/// <para>
/// <b>No foreign keys, deliberately.</b> <see cref="CompanyId"/> and <see cref="EntryId"/> are
/// there to find rows by, not to guarantee anything about them, and a log row that fails to insert
/// because the thing it describes was never written would lose exactly the line explaining why.
/// Same reasoning, and the same precedent, as <c>entry.device_id</c> (ARCHITECTURE §12).
/// </para>
/// </summary>
public sealed class AppLog
{
    /// <summary>
    /// The one non-uuid key in the product, because this is a firehose and a monotonic key is what
    /// makes keyset paging over it cheap. <b>It goes over the wire as a string</b>: JSON numbers
    /// lose precision above 2^53 in a browser, and a log id that silently changes by one, years
    /// from now, is a bug nobody would find.
    /// </summary>
    public long Id { get; set; }

    public DateTime At { get; set; }

    /// <summary>Serilog's own level name — see <see cref="AppLogLevels"/>. Stored as text rather
    /// than an enum so a log row read straight out of psql needs no lookup table.</summary>
    public string Level { get; set; } = null!;

    /// <summary>Serilog's <c>SourceContext</c>: the class that logged, e.g.
    /// <c>Teren.Infrastructure.Reporting.EntryReporter</c>. Client events use
    /// <c>web.&lt;area&gt;</c> instead, so the viewer can tell the server from the phone at a
    /// glance.</summary>
    public string Source { get; set; } = null!;

    /// <summary>The message <em>template</em>, unrendered. Kept beside the rendered message
    /// because it is the only stable thing to group by: two thousand lines about two thousand
    /// entries share one template and no two share a message.</summary>
    public string Template { get; set; } = null!;

    /// <summary>Rendered from allow-listed properties only. A dropped property stays in the text
    /// as its own placeholder, so the line reads as an omission rather than as a fact.</summary>
    public string Message { get; set; } = null!;

    /// <summary>The allow-listed structured properties as JSONB, or null when none survived.</summary>
    public string? Properties { get; set; }

    /// <summary>Scrubbed: type chain, an allow-listed message, and a truncated stack. Never the
    /// raw <c>ToString()</c> of a third-party exception.</summary>
    public string? Exception { get; set; }

    public Guid? CompanyId { get; set; }

    /// <summary>Which day of work the line is about. <b>An id is not evidence — it is how you
    /// find the row</b> (plan §12), and it is the filter that makes "why did this entry fail"
    /// answerable at all.</summary>
    public Guid? EntryId { get; set; }

    /// <summary>Ties several lines to one thing that happened. For a client event it is the
    /// event's own client-generated id, which is what lets a phone's row be recognised on a
    /// replay.</summary>
    public string? Correlation { get; set; }
}

/// <summary>
/// The six level names, exactly as Serilog spells them and exactly as they are stored.
/// <para>
/// Written down once because three places have to agree: the sink that writes them, the
/// <c>ck_app_log_level</c> CHECK that polices them, and the <c>?level=</c> filter that refuses an
/// unknown one with a 400 rather than quietly returning everything.
/// </para>
/// </summary>
public static class AppLogLevels
{
    public const string Verbose = "Verbose";
    public const string Debug = "Debug";
    public const string Information = "Information";
    public const string Warning = "Warning";
    public const string Error = "Error";
    public const string Fatal = "Fatal";

    public static readonly string[] All =
        [Verbose, Debug, Information, Warning, Error, Fatal];

    /// <summary>
    /// Case-insensitive, and it returns the canonical spelling rather than the caller's — a
    /// filter that compared <c>"error"</c> against a column holding <c>"Error"</c> would answer
    /// "no such lines" for the level an operator most wants to see.
    /// </summary>
    public static bool TryCanonicalise(string? value, out string level)
    {
        level = Array.Find(
            All, name => string.Equals(name, value?.Trim(), StringComparison.OrdinalIgnoreCase))
            ?? string.Empty;

        return level.Length > 0;
    }
}
