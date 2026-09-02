using System.Globalization;
using System.Text;
using Teren.Api.Contracts;

namespace Teren.Api.Platform;

/// <summary>
/// The log export, written as CSV straight into the response.
///
/// <para>
/// <b>The BOM is not optional and it is not decoration.</b> Excel on a Serbian Windows machine
/// reads a UTF-8 file with no byte-order mark as the system code page, and every <c>č</c>,
/// <c>ć</c> and <c>š</c> in a log line becomes mojibake. The founder opens this file in Excel;
/// three bytes are what make it readable.
/// </para>
///
/// <para>
/// <b>Written, not built.</b> Fifty thousand rows of stack traces is not a string — it is tens of
/// megabytes held twice while it is copied into the response. Each row goes out as it arrives.
/// </para>
/// </summary>
internal static class LogCsv
{
    /// <summary>The column order is the contract. Changing it silently breaks every saved
    /// spreadsheet somebody built a filter on.</summary>
    public const string Header =
        "at,level,source,message,template,company_id,entry_id,correlation,properties,exception";

    /// <summary>
    /// What the last row says when the cap cut the result short.
    /// <para>
    /// A single cell, in English, <b>inside the file</b> — because the alternative is a spreadsheet
    /// that looks complete and is not, and somebody concluding from it that an incident produced no
    /// log lines. A header the browser drops or a warning on the screen he exported from would both
    /// be gone by the time the file is read.
    /// </para>
    /// </summary>
    public static string TruncationNotice(int cap) =>
        $"TRUNCATED: this export stopped at the server limit of "
        + cap.ToString(CultureInfo.InvariantCulture)
        + " rows. Narrow the filter (level, source, company, or a from/to window) and export "
        + "again — there are older rows this file does not contain.";

    public static string FileName(DateTime utcNow) => string.Create(
        CultureInfo.InvariantCulture, $"teren-logs-{utcNow:yyyyMMdd-HHmm}.csv");

    /// <summary>A row of one cell — the shape the truncation notice takes, so it lands in column A
    /// where somebody scrolling to the bottom of the file will see it.</summary>
    public static string NoticeRow(string text) => Escape(text) + "\r\n";

    /// <summary>
    /// One row, terminated. <c>\r\n</c> because that is what every spreadsheet expects of a CSV,
    /// and because a stack trace inside a quoted field already contains bare <c>\n</c> — mixing the
    /// two is what tells a parser which newlines end a record and which do not.
    /// </summary>
    public static string Row(PlatformLogResponse log)
    {
        var row = new StringBuilder();

        Append(row, log.At.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
        Append(row, log.Level);
        Append(row, log.Source);
        Append(row, log.Message);
        Append(row, log.Template);
        Append(row, log.CompanyId?.ToString());
        Append(row, log.EntryId?.ToString());
        Append(row, log.Correlation);
        Append(row, log.Properties?.ToJsonString());
        Append(row, log.Exception, last: true);

        return row.Append("\r\n").ToString();
    }

    private static void Append(StringBuilder row, string? value, bool last = false)
    {
        row.Append(Escape(value));

        if (!last)
        {
            row.Append(',');
        }
    }

    /// <summary>
    /// RFC 4180 quoting. A field is quoted when it contains a comma, a quote, or a newline —
    /// which a scrubbed stack trace always does — and an embedded quote is doubled.
    /// <para>
    /// A leading <c>=</c>, <c>+</c>, <c>-</c> or <c>@</c> is prefixed with a single quote as well.
    /// That is not pedantry: a spreadsheet treats such a cell as a <em>formula</em>, and a log
    /// message beginning with one would be executed rather than displayed the moment the file is
    /// opened. Nothing in this table is attacker-controlled today; the whole point of the ingest
    /// route is that it might be tomorrow.
    /// </para>
    /// </summary>
    private static string Escape(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var text = value[0] is '=' or '+' or '-' or '@' ? "'" + value : value;

        return NeedsQuoting.Any(c => text.Contains(c, StringComparison.Ordinal))
            ? "\"" + text.Replace("\"", "\"\"", StringComparison.Ordinal) + "\""
            : text;
    }

    private static readonly char[] NeedsQuoting = [',', '"', '\r', '\n'];
}
