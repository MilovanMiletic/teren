using System.Text;
using Teren.Api.Contracts;
using Teren.Api.Platform;

namespace Teren.Api.Endpoints;

/// <summary>
/// The super admin's log viewer, server side (D5).
///
/// <para>
/// <b>Mapped into the same group as the rest of <c>/api/platform</c></b>, so
/// <see cref="Teren.Api.Auth.RoleFilter"/> answers 403 before a line of this file runs. That is
/// the right refusal by the product's own doctrine: whether a caller may read the log stream
/// depends on his <b>role</b> and on no row at all, so it is a question about capability and never
/// about existence. A 404 here would be a lie — the stream exists — and would also be the only
/// place in the product where 404 meant "you may not", which is exactly the erosion the doctrine
/// prevents.
/// </para>
///
/// <para>
/// Both routes take the <b>same</b> query parameters, parsed by one
/// <see cref="LogQuery"/>, because the promise the screen makes is "download what you are looking
/// at". Two handlers each parsing their own filters is how that promise breaks quietly: one gains
/// a parameter, the other does not, and the file contains more than the screen did.
/// </para>
/// </summary>
public static class PlatformLogEndpoints
{
    public static RouteGroupBuilder MapPlatformLogEndpoints(this RouteGroupBuilder platform)
    {
        platform.MapGet("/logs", ListAsync)
            .WithName("ListPlatformLogs")
            .WithSummary("The application log, newest first, keyset paged.")
            .Produces<PlatformLogListResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest);

        platform.MapGet("/logs/export", ExportAsync)
            .WithName("ExportPlatformLogs")
            .WithSummary("The same filter as a CSV download, newest first, capped.")
            .Produces(StatusCodes.Status200OK, contentType: CsvContentType)
            .ProducesProblem(StatusCodes.Status400BadRequest);

        return platform;
    }

    private const string CsvContentType = "text/csv; charset=utf-8";

    private static async Task<IResult> ListAsync(
        HttpContext http, PlatformDirectory directory, CancellationToken ct)
    {
        if (!LogQuery.TryParse(http.Request.Query, paged: true, out var query, out var error))
        {
            return ApiProblems.BadRequest(error);
        }

        return TypedResults.Ok(await directory.ListLogsAsync(query, ct));
    }

    /// <summary>
    /// The download.
    ///
    /// <para>
    /// It writes to the response itself rather than returning a payload, because a
    /// <see cref="IResult"/> carrying fifty thousand rows would be fifty thousand rows in memory —
    /// the one thing the streamed query exists to avoid. Headers are set before the first byte;
    /// after that nothing may fail in a way that needs a status code, which is why the query is
    /// parsed and refused <em>first</em>.
    /// </para>
    /// </summary>
    private static async Task<IResult> ExportAsync(
        HttpContext http, PlatformDirectory directory, CancellationToken ct)
    {
        if (!LogQuery.TryParse(http.Request.Query, paged: false, out var query, out var error))
        {
            return ApiProblems.BadRequest(error);
        }

        var response = http.Response;
        response.ContentType = CsvContentType;
        response.Headers.ContentDisposition =
            $"attachment; filename=\"{LogCsv.FileName(DateTime.UtcNow)}\"";

        // The BOM, then the header row. Without those three bytes Excel reads the file as the
        // system code page and every Serbian letter in it is mojibake.
        await using var writer = new StreamWriter(
            response.Body, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true), leaveOpen: true);

        await writer.WriteAsync(LogCsv.Header);
        await writer.WriteAsync("\r\n");

        var written = 0;

        await foreach (var log in directory.StreamLogsAsync(query, LogQuery.ExportCap, ct))
        {
            if (written == LogQuery.ExportCap)
            {
                // The cap+1'th row: proof there are more, and it is never written out as data.
                await writer.WriteAsync(
                    LogCsv.NoticeRow(LogCsv.TruncationNotice(LogQuery.ExportCap)));
                break;
            }

            await writer.WriteAsync(LogCsv.Row(log));
            written++;
        }

        await writer.FlushAsync(ct);

        return TypedResults.Empty;
    }
}
