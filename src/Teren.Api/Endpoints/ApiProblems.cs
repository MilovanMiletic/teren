namespace Teren.Api.Endpoints;

/// <summary>
/// The error vocabulary of the API, in one place so it stays consistent.
/// <para>
/// <b>Note the deliberate absence of a 403 helper, which survived D2 and must keep surviving.</b>
/// Anything the caller's company does not own is reported as <see cref="NotFound"/>, identically
/// to something that does not exist at all — a 403 from a handler would confirm that an id is
/// real, which is exactly the signal an enumerator wants.
/// </para>
/// <para>
/// D2 did introduce a 403, and the doctrine that keeps the two compatible is worth stating here
/// because this is the file someone will reach for when they want one:
/// </para>
/// <blockquote>
/// <b>404 answers questions about existence. 403 answers questions about capability.</b>
/// If the answer depends on <em>which row</em> was named → 404. If it depends only on the caller's
/// <b>role</b> and can be decided <b>without reading any row</b> → 403.
/// </blockquote>
/// <para>
/// The second case is decided by <c>RoleFilter</c>, before any handler runs and before any id is
/// examined, so it cannot leak existence. <b>No handler ever returns 403</b>; the body lives in a
/// private static inside <c>RoleFilter.cs</c>, unreachable from an endpoint file, and
/// <c>ForbiddenDoctrineTests</c> reads every <c>.cs</c> under <c>src/</c> to keep it that way.
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

    /// <summary>
    /// The media row exists and is yours, but <c>/complete</c> never certified its bytes — the
    /// upload has not arrived, or arrived at the wrong size. A <em>state</em> answer like
    /// <see cref="ReportNotReady"/>: the photograph may still be climbing out of a phone on a bad
    /// connection, which is worth saying and worth re-checking, and is a different thing from
    /// evidence that is gone.
    /// </summary>
    public const string MediaNotReady = "media_not_ready";

    /// <summary>
    /// The bytes were certified at <c>/complete</c> and cannot be served now: nothing is at the
    /// key, or what is there is not what the phone hashed. A server-side fault, reported
    /// separately from <see cref="MediaNotReady"/> because no amount of waiting fixes it — and
    /// never dressed up as a missing photograph, because on an evidence product the difference
    /// between "not uploaded" and "was uploaded and is now wrong" is the whole story.
    /// </summary>
    public const string MediaUnavailable = "media_unavailable";

    /// <summary>
    /// The worker exists and is yours, but there is no code he could type right now — never
    /// issued, already used, superseded, or expired. A <em>state</em> answer, not a missing
    /// resource: the admin's next move is to issue one, and the client can offer that button
    /// rather than showing him a not-found.
    /// </summary>
    public const string NoLiveActivationCode = "no_live_activation_code";

    /// <summary>
    /// The username the admin typed belongs to somebody. Usernames are globally unique by design
    /// (§4), so this is one of two answers in the API that reach across tenants — deliberately,
    /// and unavoidably in a global namespace. Leaving <c>username</c> out of the request avoids it
    /// entirely: the server then proposes a free one.
    /// </summary>
    public const string UsernameTaken = "username_taken";

    /// <summary>
    /// The email address is already on a Teren account. The <em>second</em> cross-tenant answer,
    /// and the reason is the same one that forced the first: <c>ux_app_user_email</c> is global,
    /// because email is the login key and a login form has no company field (§4). Uniqueness that
    /// spans tenants cannot be reported without saying something that spans tenants; the choice is
    /// between this and a 500. The detail deliberately does not repeat the address back.
    /// </summary>
    public const string EmailTaken = "email_taken";
}
