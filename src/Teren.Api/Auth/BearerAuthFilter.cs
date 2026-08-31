using Teren.Core.Tenancy;

namespace Teren.Api.Auth;

/// <summary>
/// The one gate in front of every <c>/api</c> route: no valid bearer token, no request.
/// <para>
/// It does two things and no more — reject anonymous callers, and put the caller's company into
/// <see cref="TenantContext"/> so the DbContext's global query filters scope every subsequent
/// query. <b>The company comes from the principal and from nowhere else</b>, never from a route
/// value or a header: that is layer 2 of the four that keep a super admin away from customer
/// evidence, because a super admin's <c>CompanyId</c> is null and every evidence query filter is
/// deny-by-default, so an evidence route that somehow lost its role gate returns an empty list
/// rather than a company's diary.
/// </para>
/// <para>
/// This was <c>DeviceTokenAuthFilter</c> until D2. Only the name and the item it stores changed;
/// the 401 behaviour is byte-for-byte what it was, which is what let admin sessions arrive
/// without touching a single phone-facing response.
/// </para>
/// </summary>
public sealed class BearerAuthFilter : IEndpointFilter
{
    private const string BearerPrefix = "Bearer ";
    internal const string PrincipalItemKey = "teren.principal";

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;

        // Endpoint filters are built from the application (root) provider, so per-request
        // services are resolved here rather than injected into the constructor.
        var services = http.RequestServices;
        var logger = services.GetRequiredService<ILoggerFactory>()
            .CreateLogger<BearerAuthFilter>();

        if (!TryReadBearerToken(http.Request.Headers.Authorization.ToString(), out var token))
        {
            return Challenge(http, logger, "missing or malformed Authorization header");
        }

        var authenticator = services.GetRequiredService<ICredentialAuthenticator>();
        var principal = await authenticator.AuthenticateAsync(token, http.RequestAborted);
        if (principal is null)
        {
            return Challenge(http, logger, "token not recognised");
        }

        services.GetRequiredService<TenantContext>().CompanyId = principal.CompanyId;
        http.Items[PrincipalItemKey] = principal;

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

public static class TerenPrincipalExtensions
{
    /// <summary>
    /// The authenticated caller. Only ever called from handlers behind
    /// <see cref="BearerAuthFilter"/>, so its absence is a wiring bug, not a runtime case.
    /// </summary>
    public static TerenPrincipal GetPrincipal(this HttpContext http) =>
        http.Items[BearerAuthFilter.PrincipalItemKey] as TerenPrincipal
        ?? throw new InvalidOperationException(
            "No principal on the request: this endpoint is not behind BearerAuthFilter.");

    /// <summary>
    /// The caller's company, for a handler that is behind a role gate admitting only roles that
    /// have one. A super admin reaching this is a wiring bug — a platform route that lost its gate
    /// — and it says so rather than quietly reading as company <c>Guid.Empty</c>, which would
    /// match nothing and look like an empty tenant instead of a broken one.
    /// </summary>
    public static Guid CompanyId(this TerenPrincipal principal) =>
        principal.CompanyId
        ?? throw new InvalidOperationException(
            "The caller has no company: a super admin reached a tenant-scoped handler, which "
            + "means its RoleFilter is missing or admits SuperAdmin.");
}
