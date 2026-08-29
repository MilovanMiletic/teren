using Teren.Core.Tenancy;

namespace Teren.Api.Auth;

/// <summary>
/// The one gate in front of every <c>/api</c> route: no valid bearer token, no request.
/// <para>
/// It does two things and no more — reject anonymous callers, and put the caller's company into
/// <see cref="TenantContext"/> so the DbContext's global query filters scope every subsequent
/// query. Because the filter talks to <see cref="IDeviceAuthenticator"/> rather than to any
/// particular token store, C5 (per-device tokens bound by join code) swaps the lookup and leaves
/// this pipeline untouched.
/// </para>
/// </summary>
public sealed class DeviceTokenAuthFilter : IEndpointFilter
{
    private const string BearerPrefix = "Bearer ";
    internal const string DeviceIdentityItemKey = "teren.device-identity";

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;

        // Endpoint filters are built from the application (root) provider, so per-request
        // services are resolved here rather than injected into the constructor.
        var services = http.RequestServices;
        var logger = services.GetRequiredService<ILoggerFactory>()
            .CreateLogger<DeviceTokenAuthFilter>();

        if (!TryReadBearerToken(http.Request.Headers.Authorization.ToString(), out var token))
        {
            return Challenge(http, logger, "missing or malformed Authorization header");
        }

        var authenticator = services.GetRequiredService<IDeviceAuthenticator>();
        var identity = await authenticator.AuthenticateAsync(token, http.RequestAborted);
        if (identity is null)
        {
            return Challenge(http, logger, "token not recognised");
        }

        services.GetRequiredService<TenantContext>().CompanyId = identity.CompanyId;
        http.Items[DeviceIdentityItemKey] = identity;

        return await next(context);
    }

    private static bool TryReadBearerToken(string? header, out string token)
    {
        token = string.Empty;
        if (string.IsNullOrWhiteSpace(header)
            || !header.StartsWith(BearerPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        token = header[BearerPrefix.Length..].Trim();
        return token.Length > 0;
    }

    private static IResult Challenge(HttpContext http, ILogger logger, string reason)
    {
        // Logged with the reason, never with the presented token.
        logger.LogWarning(
            "Rejected {Method} {Path}: {Reason}.", http.Request.Method, http.Request.Path, reason);

        http.Response.Headers.WWWAuthenticate = "Bearer";
        return TypedResults.Problem(
            title: "Unauthorized",
            detail: "A valid device bearer token is required.",
            statusCode: StatusCodes.Status401Unauthorized);
    }
}

public static class DeviceIdentityExtensions
{
    /// <summary>
    /// The authenticated caller. Only ever called from handlers behind
    /// <see cref="DeviceTokenAuthFilter"/>, so its absence is a wiring bug, not a runtime case.
    /// </summary>
    public static DeviceIdentity GetDeviceIdentity(this HttpContext http) =>
        http.Items[DeviceTokenAuthFilter.DeviceIdentityItemKey] as DeviceIdentity
        ?? throw new InvalidOperationException(
            "No device identity on the request: this endpoint is not behind DeviceTokenAuthFilter.");
}
