using Microsoft.AspNetCore.Diagnostics;
using Teren.Api.Logging;
using Teren.Core.Storage;

namespace Teren.Api.Errors;

/// <summary>
/// Object storage being unreachable is a "come back shortly", not a crash: 503 with a
/// Retry-After, so the phone's outbox backs off and retries instead of treating a temporary
/// outage as a permanent failure of the entry.
/// </summary>
public sealed class StorageUnavailableExceptionHandler(
    IProblemDetailsService problemDetailsService,
    ILogger<StorageUnavailableExceptionHandler> logger) : IExceptionHandler
{
    private const int RetryAfterSeconds = 5;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not ObjectStorageUnavailableException)
        {
            return false;
        }

        // The route template, not the URL: this handler runs for anonymous callers too, and a
        // path segment is whatever the caller typed (see LoggableRoute).
        logger.LogError(
            exception, "Storage unavailable while serving {Method} {Route}.",
            httpContext.Request.Method, LoggableRoute.Of(httpContext));

        httpContext.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        httpContext.Response.Headers.RetryAfter = RetryAfterSeconds.ToString();

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails =
            {
                Title = "Storage unavailable",
                Status = StatusCodes.Status503ServiceUnavailable,
                // No internal endpoint, host or SDK message: the client can act on none of it.
                Detail = "Object storage could not be reached. Nothing was lost — retry shortly.",
            },
        });
    }
}
