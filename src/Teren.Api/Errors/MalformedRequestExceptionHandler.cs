using Microsoft.AspNetCore.Diagnostics;
using Teren.Api.Logging;

namespace Teren.Api.Errors;

/// <summary>
/// Turns a request the framework could not even read — a query parameter that is not a UUID, a
/// JSON body that is not JSON — into a 400 with problem details.
/// <para>
/// Without this, ASP.NET's binding failure surfaces as <see cref="BadHttpRequestException"/>,
/// the exception handler treats it like any other crash, and the client gets a 500 for its own
/// mistake. A phone that is told "server error" will keep retrying a payload that can never
/// succeed.
/// </para>
/// </summary>
public sealed class MalformedRequestExceptionHandler(
    IProblemDetailsService problemDetailsService,
    IHostEnvironment environment,
    ILogger<MalformedRequestExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not BadHttpRequestException badRequest)
        {
            return false;
        }

        // NOTHING user-derived is logged here, and this is the site that made that rule necessary.
        // Parameter binding runs before the auth filter, so this line is reachable with no
        // credential at all; the framework's message names the offending value, and the URL is
        // whatever the caller typed. The route template and the status are what an operator can
        // act on, and neither can be written from outside (see LoggableRoute).
        logger.LogInformation(
            "Malformed {Method} {Route}: rejected with {Status}.",
            httpContext.Request.Method,
            LoggableRoute.Of(httpContext),
            badRequest.StatusCode);

        httpContext.Response.StatusCode = badRequest.StatusCode;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails =
            {
                Title = "Bad request",
                Status = badRequest.StatusCode,
                // The framework's message names parameters and echoes the offending value, which
                // is useful on a laptop and needless exposure anywhere else.
                Detail = environment.IsDevelopment()
                    ? badRequest.Message
                    : "The request could not be read: a parameter or the JSON body is malformed.",
            },
        });
    }
}
