namespace Teren.Api.Endpoints;

/// <summary>
/// The error vocabulary of the API, in one place so it stays consistent.
/// <para>
/// Note the deliberate absence of 403: anything the caller's company does not own is reported as
/// <see cref="NotFound"/>, identically to something that does not exist at all. A 403 would
/// confirm that an id is real, which is exactly the signal an enumerator wants.
/// </para>
/// <para>
/// Some problems also carry a <c>code</c> — a stable, snake_case token in the problem-details
/// body — for the cases where the client has to *branch*, not merely display. The detail string
/// is English prose for a human reading a log; a phone must never parse it. This is the same
/// lesson B3 already learned about 409s (CLAUDE.md: "a 409 is never judged alone... never on the
/// English detail string").
/// </para>
/// </summary>
internal static class ApiProblems
{
    public static IResult NotFound(string detail) => TypedResults.Problem(
        title: "Not found", detail: detail, statusCode: StatusCodes.Status404NotFound);

    public static IResult BadRequest(string detail) => TypedResults.Problem(
        title: "Bad request", detail: detail, statusCode: StatusCodes.Status400BadRequest);

    public static IResult Conflict(string detail) => TypedResults.Problem(
        title: "Conflict", detail: detail, statusCode: StatusCodes.Status409Conflict);

    /// <summary>A 409 the client can branch on. <paramref name="code"/> is the contract;
    /// <paramref name="detail"/> is for the human reading the log.</summary>
    public static IResult Conflict(string code, string detail) => TypedResults.Problem(
        title: "Conflict",
        detail: detail,
        statusCode: StatusCodes.Status409Conflict,
        extensions: new Dictionary<string, object?> { ["code"] = code });
}

/// <summary>
/// The <c>code</c> values <see cref="ApiProblems.Conflict(string, string)"/> puts on the wire.
/// Constants rather than literals at the call site because these are a published contract with
/// the PWA: renaming one silently is how a phone stops distinguishing "not ready yet" from
/// "gone".
/// </summary>
internal static class ApiProblemCodes
{
    /// <summary>The entry exists and is yours, but no report has been sent for it yet — it has
    /// not been confirmed, or the report is still in flight, or the last attempt failed. The
    /// client polls <c>GET /api/entries/{id}</c> to find out which.</summary>
    public const string ReportNotReady = "report_not_ready";

    /// <summary>
    /// The report was sent, but its PDF is not in object storage, or the stored bytes are not the
    /// bytes that were sent. A server-side fault rather than anything the client did: retrying
    /// will not fix it, and it is reported separately from
    /// <see cref="ReportNotReady"/> so the app can say something true rather than "try later".
    /// </summary>
    public const string ReportUnavailable = "report_unavailable";
}
