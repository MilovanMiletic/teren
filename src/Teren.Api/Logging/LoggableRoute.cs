using Microsoft.AspNetCore.Diagnostics;

namespace Teren.Api.Logging;

/// <summary>
/// Where a request was going, in a form that is safe to store — the <b>matched route template</b>,
/// never the URL the caller typed.
///
/// <para>
/// <b>This exists because <c>http.Request.Path</c> is caller-controlled text.</b> The three places
/// that used to log it — the 401 challenge, the 403 refusal and the storage-unavailable handler —
/// are precisely the places that run for people who have proved nothing: the 401 path runs before
/// any credential is checked, and parameter binding runs before that. A matched route with a free
/// segment (<c>/api/entries/{id}</c>) was therefore an anonymous write of up to
/// <see cref="Teren.Infrastructure.Logging.LogScrubbing.MaxText"/> characters into the one table
/// Teren staff read — the table whose entire claim is that it cannot carry a customer's words.
/// </para>
///
/// <para>
/// The template comes from the route table, so it is a fact about this application's own code and
/// can never be anything a caller supplied. It also says more than the URL did: <c>/api/entries/
/// {id}</c> names the route, which is what an operator is actually looking for, while the id in a
/// concrete path was noise he would have had to squint past.
/// </para>
/// </summary>
public static class LoggableRoute
{
    /// <summary>What stands in when routing matched nothing — an exception handler reached before
    /// or outside the routing middleware. Never an empty string: a blank in a log viewer reads as
    /// a rendering bug rather than as "there was no route".</summary>
    public const string Unmatched = "(no route)";

    /// <summary>
    /// <b>Two places to look, and the second is not optional.</b> In a filter or a handler the
    /// endpoint is on the context. In an <see cref="IExceptionHandler"/> it is not:
    /// <c>UseExceptionHandler</c> clears the endpoint and the route values before re-executing, so
    /// that the error pipeline can route freshly — which turned every line from the two exception
    /// handlers into "(no route)" and told an operator nothing at all about which route had
    /// failed. The original endpoint survives on
    /// <see cref="IExceptionHandlerFeature"/>. Its <c>Path</c> is <em>not</em> read here: that is
    /// the URL the caller typed, which is the whole point of this class.
    /// </summary>
    public static string Of(HttpContext http) =>
        Template(http.GetEndpoint())
        ?? Template(http.Features.Get<IExceptionHandlerFeature>()?.Endpoint)
        ?? Unmatched;

    private static string? Template(Endpoint? endpoint) =>
        (endpoint as RouteEndpoint)?.RoutePattern.RawText;
}
