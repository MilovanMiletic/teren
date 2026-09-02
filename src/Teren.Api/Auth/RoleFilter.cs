using Teren.Api.Logging;
using Teren.Core.Entities;
using Teren.Core.Tenancy;

namespace Teren.Api.Auth;

/// <summary>
/// The route-level role gate, and <b>the only thing in this API that emits a 403</b>
/// (profile-and-identity §8).
/// <para>
/// The doctrine it upholds, stated as two sentences that decide every case:
/// </para>
/// <blockquote>
/// <b>404 answers questions about existence. 403 answers questions about capability.</b>
/// If the answer depends on <em>which row</em> was named and that row is outside the caller's
/// company → 404, unchanged. If it depends only on the caller's <b>role</b> and can be decided
/// <b>without reading any row</b> → 403.
/// </blockquote>
/// <para>
/// The safety property falls out of where this runs: it is an endpoint filter, so it answers
/// <em>before the handler is entered</em>, before a route parameter has been parsed and before a
/// single row has been read. It therefore <b>cannot leak the existence of anything</b> — which is
/// what makes it safe to add a 403 to a codebase whose whole tenancy doctrine is "foreign is
/// indistinguishable from nonexistent".
/// </para>
/// <para>
/// <b>No handler ever returns 403, and <c>ApiProblems</c> still has no 403 helper.</b> The body
/// below is produced by a private static in this file precisely so it is unreachable from an
/// endpoint file; <c>ForbiddenIsOnlyEmittedByTheRoleFilterTests</c> reads every <c>.cs</c> under
/// <c>src/</c> and fails if 403 is mentioned anywhere else.
/// </para>
/// <para>
/// <b>Filter order is <c>BearerAuthFilter</c> → <c>RoleFilter</c> → <c>ValidationFilter&lt;T&gt;</c></b>,
/// so <b>401 beats 403 beats 400</b>: an anonymous caller learns nothing about which roles a route
/// admits, and a caller of the wrong role learns nothing about the shape of its payload. Group
/// filters run outside route filters, so admitting roles on the group is what puts this in the
/// middle. The two tests that assert the resulting <em>behaviour</em> rather than the wiring are
/// <c>RoleGateTests.An_anonymous_caller_learns_nothing_about_which_roles_a_route_admits</c> and
/// <c>RoleGateTests.A_caller_of_the_wrong_role_learns_nothing_about_the_payload_shape</c>.
/// </para>
/// </summary>
public sealed class RoleFilter(params AppUserRole[] allowed) : IEndpointFilter
{
    private readonly AppUserRole[] _allowed = allowed.Length > 0
        ? allowed
        : throw new ArgumentException(
            "A RoleFilter that admits nobody is a route nobody can call; say which roles it is "
            + "for.", nameof(allowed));

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var principal = http.GetPrincipal();

        if (Array.IndexOf(_allowed, principal.Role) < 0)
        {
            http.RequestServices.GetRequiredService<ILoggerFactory>()
                .CreateLogger<RoleFilter>()
                .LogWarning(
                    // The role and the route TEMPLATE, never the user's name and never the URL he
                    // typed: this line goes to the log stream a super admin reads, and a URL is
                    // caller-controlled text (see LoggableRoute).
                    "Refused {Method} {Route}: role {Role} is not admitted here.",
                    http.Request.Method,
                    LoggableRoute.Of(http),
                    AppUserRoleNames.ToWire(principal.Role));

            return Forbidden();
        }

        return await next(context);
    }

    /// <summary>
    /// The one 403 body in the product. Deliberately says nothing about <em>which</em> roles the
    /// route admits: that is a map of the admin surface, and a worker's phone has no use for it.
    /// </summary>
    private static IResult Forbidden() => TypedResults.Problem(
        title: "Forbidden",
        detail: "Your role may not perform this action.",
        statusCode: StatusCodes.Status403Forbidden);
}

/// <summary>
/// How a route says who it is for. Reads as a sentence at the call site, which is the point — a
/// gate nobody can see is a gate somebody will forget.
/// </summary>
public static class RoleGates
{
    /// <summary>
    /// Everyone who can hold evidence: the foreman who records it and the customer who owns it.
    /// <b>Super admin is absent, and that absence is layer 1 of the privacy claim</b>
    /// (profile-and-identity §6): Teren staff can see which companies and sites exist and what is
    /// failing, and cannot read a transcript, view a photo, or open a report.
    /// </summary>
    public static readonly AppUserRole[] Evidence =
        [AppUserRole.Worker, AppUserRole.CompanyAdmin];

    /// <summary>The customer's own administrative surface: his workers, their codes, his phones.</summary>
    public static readonly AppUserRole[] CompanyAdmin = [AppUserRole.CompanyAdmin];

    /// <summary>Teren staff.</summary>
    public static readonly AppUserRole[] SuperAdmin = [AppUserRole.SuperAdmin];

    /// <summary>Both roles that sign in with an email and a password, and therefore both roles
    /// that have a session to end.</summary>
    public static readonly AppUserRole[] Admins =
        [AppUserRole.SuperAdmin, AppUserRole.CompanyAdmin];

    public static RouteGroupBuilder RequireRole(
        this RouteGroupBuilder group, params AppUserRole[] allowed)
    {
        group.AddEndpointFilter(new RoleFilter(allowed));
        return group;
    }

    public static RouteHandlerBuilder RequireRole(
        this RouteHandlerBuilder route, params AppUserRole[] allowed)
    {
        route.AddEndpointFilter(new RoleFilter(allowed));
        return route;
    }
}
