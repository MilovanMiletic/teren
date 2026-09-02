using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Contracts;
using Teren.Core.Entities;

namespace Teren.Api.Platform;

/// <summary>
/// The log stream half of the platform surface (D5).
///
/// <para>
/// <b>It is a partial of <see cref="PlatformDirectory"/> and not a class of its own, deliberately.</b>
/// <c>PlatformPrivacyTests</c> reflects over one named type and fails if any public signature on
/// it reaches <c>Entry</c>, <c>Media</c> or <c>Report</c>. A second class beside it would be a
/// second surface the guard does not look at — which is precisely the hole the guard exists to
/// close, opened in the name of tidiness.
/// </para>
///
/// <para>
/// It reads <see cref="Teren.Infrastructure.Persistence.TerenIdentityDbContext"/> like the rest of
/// this type, so the log viewer is compiled against a model with no evidence in it. Note the
/// caveat ARCHITECTURE §12 states honestly: this is a model barrier, not a connection barrier —
/// raw SQL on the same connection could still reach <c>entry</c>. There is none here, and
/// <c>PlatformRawSqlTests</c> is what keeps it that way.
/// </para>
/// </summary>
public sealed partial class PlatformDirectory
{
    /// <summary>
    /// One page of the stream, newest first.
    /// <para>
    /// One row more than asked for is fetched, which is how the cursor knows whether there is a
    /// next page without counting a table that is being written to while it counts.
    /// </para>
    /// </summary>
    public async Task<PlatformLogListResponse> ListLogsAsync(LogQuery query, CancellationToken ct)
    {
        var rows = await Filtered(query)
            .OrderByDescending(l => l.At).ThenByDescending(l => l.Id)
            .Take(query.Limit + 1)
            .ToListAsync(ct);

        var page = rows.Take(query.Limit).ToList();
        var hasMore = rows.Count > query.Limit;

        return new PlatformLogListResponse(
            [.. page.Select(Describe)],
            hasMore && page.Count > 0
                ? new LogKeyset(page[^1].At, page[^1].Id).Encode()
                : null);
    }

    /// <summary>
    /// The same filter, unpaged and streamed, for the CSV download.
    ///
    /// <para>
    /// <b><see cref="IAsyncEnumerable{T}"/> and not a list.</b> Fifty thousand rows of stack traces
    /// materialised into memory to be turned into a string is a large allocation on a small VPS,
    /// and the whole point of the export is that it can be big. Streaming means the rows go out of
    /// the socket as they come off the connection.
    /// </para>
    /// <para>
    /// It yields one row more than <paramref name="cap"/> when there are more, so the caller can
    /// tell a full file from a truncated one and say so in the file itself. A spreadsheet that
    /// looks complete and is not is how somebody concludes an incident had no log lines.
    /// </para>
    /// </summary>
    public async IAsyncEnumerable<PlatformLogResponse> StreamLogsAsync(
        LogQuery query,
        int cap,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var rows = Filtered(query)
            .OrderByDescending(l => l.At).ThenByDescending(l => l.Id)
            .Take(cap + 1)
            .AsAsyncEnumerable();

        await foreach (var log in rows.WithCancellation(ct))
        {
            yield return Describe(log);
        }
    }

    private IQueryable<AppLog> Filtered(LogQuery query)
    {
        var logs = db.Logs.AsNoTracking().AsQueryable();

        if (query.Levels.Count > 0)
        {
            var levels = query.Levels;
            logs = logs.Where(l => levels.Contains(l.Level));
        }

        if (Search.Wanted(query.Source, out var sourcePattern))
        {
            logs = logs.Where(l => EF.Functions.ILike(l.Source, sourcePattern));
        }

        if (query.CompanyId is { } companyId)
        {
            logs = logs.Where(l => l.CompanyId == companyId);
        }

        if (query.EntryId is { } entryId)
        {
            logs = logs.Where(l => l.EntryId == entryId);
        }

        if (Search.Wanted(query.Q, out var textPattern))
        {
            // Message and template only. Never `properties`, never `exception` — see LogQuery.Q.
            logs = logs.Where(l =>
                EF.Functions.ILike(l.Message, textPattern)
                || EF.Functions.ILike(l.Template, textPattern));
        }

        if (query.From is { } from)
        {
            logs = logs.Where(l => l.At >= from);
        }

        if (query.To is { } to)
        {
            logs = logs.Where(l => l.At < to);
        }

        if (query.After is { } cursor)
        {
            // Strictly after the cursor row in (at DESC, id DESC). The OR arm is what makes ties
            // correct: a flush writes a batch of rows sharing a timestamp, and a keyset over a
            // non-unique key either skips them or repeats them forever.
            logs = logs.Where(l =>
                l.At < cursor.At || (l.At == cursor.At && l.Id < cursor.Id));
        }

        return logs;
    }

    private static PlatformLogResponse Describe(AppLog log) => new(
        // A string on the wire: a bigserial past 2^53 loses precision as a JSON number, and a log
        // id that is quietly wrong by one is a bug that appears years from now.
        log.Id.ToString(CultureInfo.InvariantCulture),
        new DateTimeOffset(DateTime.SpecifyKind(log.At, DateTimeKind.Utc)),
        log.Level,
        log.Source,
        log.Template,
        log.Message,
        Structured(log.Properties),
        log.Exception,
        log.CompanyId,
        log.EntryId,
        log.Correlation);

    /// <summary>
    /// The <c>jsonb</c> column as inline JSON.
    /// <para>
    /// Postgres validates the column, so a parse failure here is not a caller's problem and must
    /// not be a 500 on a whole page of log lines. A row whose properties will not parse comes back
    /// with none rather than taking the page down — the message, the template and the exception
    /// are the parts somebody is reading anyway.
    /// </para>
    /// </summary>
    private static JsonNode? Structured(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(json);
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }
}
