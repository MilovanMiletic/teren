using System.Globalization;
using Teren.Core.Entities;

namespace Teren.Api.Platform;

/// <summary>
/// The filter behind both <c>GET /api/platform/logs</c> and <c>GET /api/platform/logs/export</c>.
///
/// <para>
/// <b>One type, parsed once, so the download is what he is looking at.</b> The two routes take the
/// same query parameters by contract, and the way that promise gets broken is two handlers each
/// parsing their own — one gains a filter, the other does not, and an operator exports a file that
/// silently contains more than the screen he exported it from.
/// </para>
///
/// <para>
/// <b>An unknown level is a 400, not an ignored parameter.</b> Same reasoning as the user list's
/// <c>role</c> and <c>status</c>: silently dropping a filter answers a different question from the
/// one asked, and on a firehose the caller cannot possibly notice — he would read a full stream as
/// "nothing matched my filter".
/// </para>
/// </summary>
public sealed record LogQuery
{
    /// <summary>The hard ceiling on an export, whatever the filter. 50 000 lines of stack traces is
    /// already a file nobody opens twice; without a cap this route is "send me the table".</summary>
    public const int ExportCap = 50_000;

    public IReadOnlyList<string> Levels { get; init; } = [];

    /// <summary>Case-insensitive <em>contains</em> over <c>source</c>.</summary>
    public string? Source { get; init; }

    public Guid? CompanyId { get; init; }

    public Guid? EntryId { get; init; }

    /// <summary>
    /// Case-insensitive contains over <c>message</c> <b>and</b> <c>template</c>.
    /// <para>
    /// <b>Never over <c>properties</c> and never over <c>exception</c>.</b> Those two are the only
    /// columns holding text nobody wrote by hand, and a search box over them is a way to fish
    /// through stack traces for a word — which is a different power from reading the stream, and
    /// not one this screen grants.
    /// </para>
    /// </summary>
    public string? Q { get; init; }

    /// <summary>Inclusive.</summary>
    public DateTime? From { get; init; }

    /// <summary>Exclusive, so two adjacent windows neither overlap nor drop a row between them.</summary>
    public DateTime? To { get; init; }

    public LogKeyset? After { get; init; }

    public int Limit { get; init; } = Keyset.DefaultLimit;

    /// <summary>
    /// Reads the query string, or names the first thing wrong with it.
    /// <para>
    /// <paramref name="paged"/> false is the export: it takes the same filters but has no cursor
    /// and no limit, and a caller who sent one is told rather than having it quietly ignored.
    /// </para>
    /// </summary>
    public static bool TryParse(
        IQueryCollection query, bool paged, out LogQuery result, out string error)
    {
        result = new LogQuery();
        error = string.Empty;

        var levels = new List<string>();
        foreach (var raw in query["level"])
        {
            // Repeatable *and* comma-separated: a screen builds `?level=Error&level=Fatal`, a
            // person types `?level=error,fatal`, and refusing either would be a footnote nobody
            // reads.
            foreach (var candidate in (raw ?? string.Empty).Split(
                         ',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!AppLogLevels.TryCanonicalise(candidate, out var level))
                {
                    error = $"Unknown level '{candidate}'. Expected one of: "
                        + $"{string.Join(", ", AppLogLevels.All)}.";
                    return false;
                }

                if (!levels.Contains(level, StringComparer.Ordinal))
                {
                    levels.Add(level);
                }
            }
        }

        if (!TryGuid(query, "company_id", out var companyId, out error)
            || !TryGuid(query, "entry_id", out var entryId, out error)
            || !TryInstant(query, "from", out var from, out error)
            || !TryInstant(query, "to", out var to, out error))
        {
            return false;
        }

        if (from is not null && to is not null && to <= from)
        {
            error = "`to` must be after `from`; as written the window contains nothing.";
            return false;
        }

        LogKeyset? after = null;
        var limit = paged ? Keyset.DefaultLimit : ExportCap;

        if (paged)
        {
            var cursor = query["cursor"].ToString();
            if (!string.IsNullOrWhiteSpace(cursor))
            {
                if (!LogKeyset.TryDecode(cursor, out var decoded))
                {
                    // Never a silent fall back to page one: that is how a client loops over the
                    // first page forever while every request looks healthy.
                    error = "The cursor is not one this server issued. Start from the first page "
                        + "and follow next_cursor.";
                    return false;
                }

                after = decoded;
            }

            var requested = query["limit"].ToString();
            if (!string.IsNullOrWhiteSpace(requested))
            {
                if (!int.TryParse(requested, CultureInfo.InvariantCulture, out var value))
                {
                    error = "limit must be a whole number between 1 and "
                        + $"{Keyset.MaxLimit}.";
                    return false;
                }

                limit = Keyset.Limit(value);
            }
        }

        result = new LogQuery
        {
            Levels = levels,
            Source = Trimmed(query, "source"),
            CompanyId = companyId,
            EntryId = entryId,
            Q = Trimmed(query, "q"),
            From = from,
            To = to,
            After = after,
            Limit = limit,
        };

        return true;
    }

    private static string? Trimmed(IQueryCollection query, string name)
    {
        var value = query[name].ToString().Trim();
        return value.Length == 0 ? null : value;
    }

    private static bool TryGuid(
        IQueryCollection query, string name, out Guid? value, out string error)
    {
        value = null;
        error = string.Empty;

        var raw = query[name].ToString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        if (!Guid.TryParse(raw, out var parsed))
        {
            error = $"{name} is not a valid UUID.";
            return false;
        }

        value = parsed;
        return true;
    }

    /// <summary>
    /// ISO-8601 in, UTC out. A stamp with no offset is read as UTC rather than as the server's
    /// local time — every instant in this product is UTC, and a filter that quietly shifted by the
    /// host's time zone would return a plausible, wrong window.
    /// </summary>
    private static bool TryInstant(
        IQueryCollection query, string name, out DateTime? value, out string error)
    {
        value = null;
        error = string.Empty;

        var raw = query[name].ToString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        if (!DateTimeOffset.TryParse(
                raw,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var parsed))
        {
            error = $"{name} is not an ISO-8601 instant (for example 2026-09-02T18:00:00Z).";
            return false;
        }

        value = parsed.UtcDateTime;
        return true;
    }
}
