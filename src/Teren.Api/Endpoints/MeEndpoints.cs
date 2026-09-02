using Microsoft.EntityFrameworkCore;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Core.Entities;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

/// <summary>
/// Who am I, and (for an admin) stop being me.
/// <para>
/// <c>GET /api/me</c> is the PWA's "is my credential still good" probe. It is the one place the
/// app can ask that question without writing anything, and it costs exactly what any other
/// authenticated request costs — the credential check has already happened in
/// <see cref="BearerAuthFilter"/> by the time this handler runs.
/// </para>
/// </summary>
public static class MeEndpoints
{
    public static RouteGroupBuilder MapMeEndpoints(this RouteGroupBuilder api)
    {
        // No role gate: every role has a "me", and a route that answers only "who is holding this
        // token" cannot leak anything the holder does not already have.
        api.MapGet("/me", GetMeAsync)
            .WithTags("Identity")
            .WithName("GetMe")
            .WithSummary("The caller: role, name, company and (for a phone) its device.")
            .Produces<MeResponse>();

        api.MapGroup("/auth")
            .WithTags("Identity")
            // A worker has no session to end. "There is no sign-out" is a product decision
            // (§10.4): re-activation replaces a phone's credential, and signing out would either
            // do nothing or strand a day of evidence behind a door he cannot reopen on site.
            .RequireRole(RoleGates.Admins)
            .MapPost("/logout", LogoutAsync)
            .WithName("Logout")
            .WithSummary("End this admin session. Other sessions of the same user are untouched.")
            .Produces(StatusCodes.Status204NoContent);

        return api;
    }

    private static async Task<IResult> GetMeAsync(
        HttpContext http, TerenIdentityDbContext db, CancellationToken ct)
    {
        var principal = http.GetPrincipal();

        var user = await db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == principal.UserId, ct);

        if (user is null)
        {
            // Unreachable in practice: the authenticator joined this row a moment ago. If it ever
            // happens, the credential is no longer good and the honest answer is the same 401 the
            // filter would have given.
            return TypedResults.Problem(
                title: "Unauthorized",
                detail: "A valid device bearer token is required.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        CompanyRefResponse? company = null;

        if (user.CompanyId is Guid companyId)
        {
            var row = await db.Companies
                .AsNoTracking()
                .FirstOrDefaultAsync(c => c.Id == companyId, ct);

            company = row is null ? null : new CompanyRefResponse(row.Id, row.Name);
        }

        MeDeviceResponse? device = null;

        if (principal.DeviceId is Guid deviceId)
        {
            var row = await db.Devices
                .AsNoTracking()
                .FirstOrDefaultAsync(d => d.Id == deviceId, ct);

            device = row is null ? null : new MeDeviceResponse(row.Id, row.Name);
        }

        return TypedResults.Ok(new MeResponse(
            AppUserRoleNames.ToWire(user.Role),
            user.Id,
            user.DisplayName,
            user.Username,
            user.Email,
            user.Language,
            company,
            device,
            Utc(user.CreatedAt),
            UtcOrNull(user.LastLoginAt)));
    }

    // Npgsql hands back an unspecified-kind DateTime for a timestamptz column, and serialising
    // that produces a stamp with no offset that a browser then reads as local time. Same two
    // helpers, for the same reason, as PlatformDirectory.
    private static DateTimeOffset Utc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static DateTimeOffset? UtcOrNull(DateTime? value) =>
        value is null ? null : Utc(value.Value);

    /// <summary>
    /// Revokes <b>this</b> session and no other. A man signing out of a shared office machine must
    /// not be signed out of his phone's browser at the same time — and a stamp rather than a
    /// delete keeps the row for the audit trail.
    /// </summary>
    private static async Task<IResult> LogoutAsync(
        HttpContext http, TerenIdentityDbContext db, CancellationToken ct)
    {
        var principal = http.GetPrincipal();

        if (principal.SessionId is Guid sessionId)
        {
            await db.AdminSessions
                .Where(s => s.Id == sessionId && s.RevokedAt == null)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.RevokedAt, DateTime.UtcNow), ct);
        }

        // 204 either way: idempotent, and an admin who somehow arrives without a session (there is
        // no such path today) still gets "you are signed out" rather than an error he cannot act
        // on.
        return TypedResults.NoContent();
    }
}
