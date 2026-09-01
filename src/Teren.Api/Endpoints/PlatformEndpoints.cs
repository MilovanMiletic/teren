using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Api.Platform;
using Teren.Api.Validation;
using Teren.Core.Entities;

namespace Teren.Api.Endpoints;

/// <summary>
/// Teren's own surface: customers, accounts, and the trail of what staff have done (plan §8, D4).
///
/// <para>
/// <b>Gated to <c>super_admin</c> by <see cref="RoleFilter"/></b>, which answers 403 before a line
/// of this file runs — before an id is parsed and before a row is read — so it cannot leak the
/// existence of anything. That gate is also <b>layer 1 of the privacy claim in reverse</b>: the
/// evidence routes admit `worker` and `company_admin` and not this role, so a super admin is
/// refused there by the same mechanism that admits him here.
/// </para>
///
/// <para>
/// <b>404 here means something different from 404 elsewhere, and the difference is worth stating.</b>
/// On the customer surfaces a foreign row is a 404 because existence must not be leaked across
/// tenants. On this surface there is no tenant to be outside of — a super admin may see every
/// account there is — so a 404 means the row genuinely does not exist. The one deliberate
/// exception is inviting a worker: it answers 404 rather than an explanation, because a worker
/// cannot have a password by construction (<c>ck_app_user_worker_has_no_password</c>) and "there
/// is no invitable account with that id" is exactly true.
/// </para>
///
/// <para>
/// Every handler is thin on purpose. The work lives in <see cref="PlatformDirectory"/>, which is
/// the one type the privacy reflection guard has to inspect; a handler that queried the database
/// directly would be a hole in that proof.
/// </para>
/// </summary>
public static class PlatformEndpoints
{
    public static RouteGroupBuilder MapPlatformEndpoints(this RouteGroupBuilder api)
    {
        var group = api.MapGroup("/platform")
            .WithTags("Platform")
            .RequireRole(RoleGates.SuperAdmin);

        group.MapGet("/companies", ListCompaniesAsync)
            .WithName("ListCompanies")
            .WithSummary("Every customer, newest first, keyset paged.")
            .Produces<PlatformCompanyListResponse>();

        group.MapPost("/companies", CreateCompanyAsync)
            .AddEndpointFilter<ValidationFilter<CreateCompanyRequest>>()
            .WithName("CreateCompany")
            .WithSummary("Add a customer. Creates nothing else.")
            .Produces<PlatformCompanyResponse>(StatusCodes.Status201Created);

        group.MapPost("/companies/{id}/suspend", SuspendCompanyAsync)
            .WithName("SuspendCompany")
            .WithSummary("Withdraw a customer's access. Every credential of theirs 401s on next contact.")
            .Produces<PlatformCompanyResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapPost("/companies/{id}/resume", ResumeCompanyAsync)
            .WithName("ResumeCompany")
            .WithSummary("Give it back.")
            .Produces<PlatformCompanyResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapGet("/users", ListUsersAsync)
            .WithName("ListPlatformUsers")
            .WithSummary("Every account, filtered by company, role, status or free text.")
            .Produces<PlatformUserListResponse>();

        group.MapPost("/users/{id}/invite", InviteUserAsync)
            .WithName("InvitePlatformUser")
            .WithSummary("Mint a set-password link and return it, so it can be read down the phone.")
            .Produces<InviteUserResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapPost("/users/{id}/disable", DisableUserAsync)
            .WithName("DisablePlatformUser")
            .WithSummary("Withdraw one account. A soft stamp; never a delete.")
            .Produces<PlatformUserResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapPost("/users/{id}/enable", EnableUserAsync)
            .WithName("EnablePlatformUser")
            .WithSummary("Give it back.")
            .Produces<PlatformUserResponse>()
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapGet("/audit", ListAuditAsync)
            .WithName("ListPlatformAudit")
            .WithSummary("What administrators have done, newest first.")
            .Produces<PlatformAuditListResponse>();

        return api;
    }

    // ------------------------------------------------------------------------------ companies

    private static async Task<IResult> ListCompaniesAsync(
        PlatformDirectory directory,
        CancellationToken ct,
        string? q = null,
        string? cursor = null,
        int? limit = null)
    {
        if (!TryCursor(cursor, out var after))
        {
            return BadCursor();
        }

        return TypedResults.Ok(await directory.ListCompaniesAsync(q, after, limit, ct));
    }

    private static async Task<IResult> CreateCompanyAsync(
        CreateCompanyRequest request,
        HttpContext http,
        PlatformDirectory directory,
        CancellationToken ct)
    {
        var company = await directory.CreateCompanyAsync(
            request.Name!, http.GetPrincipal().UserId, ct);

        return TypedResults.Created($"/api/platform/companies/{company.Id}", company);
    }

    private static Task<IResult> SuspendCompanyAsync(
        string id, HttpContext http, PlatformDirectory directory, CancellationToken ct) =>
        SetCompanySuspendedAsync(id, true, http, directory, ct);

    private static Task<IResult> ResumeCompanyAsync(
        string id, HttpContext http, PlatformDirectory directory, CancellationToken ct) =>
        SetCompanySuspendedAsync(id, false, http, directory, ct);

    private static async Task<IResult> SetCompanySuspendedAsync(
        string id, bool suspended, HttpContext http, PlatformDirectory directory, CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var companyId))
        {
            return ApiProblems.BadRequest("The company id in the path is not a valid UUID.");
        }

        var company = await directory.SetCompanySuspendedAsync(
            companyId, suspended, http.GetPrincipal().UserId, ct);

        return company is null
            ? ApiProblems.NotFound($"Company {companyId} was not found.")
            : TypedResults.Ok(company);
    }

    // ---------------------------------------------------------------------------------- users

    private static async Task<IResult> ListUsersAsync(
        PlatformDirectory directory,
        CancellationToken ct,
        Guid? company_id = null,
        string? role = null,
        string? status = null,
        string? q = null,
        string? cursor = null,
        int? limit = null)
    {
        if (!TryCursor(cursor, out var after))
        {
            return BadCursor();
        }

        // An unknown role or status is a 400 rather than an ignored parameter. Silently dropping a
        // filter answers a different question than the one asked, and on a list this long the
        // caller has no way to notice — he would read a full listing as "nobody matched".
        AppUserRole? parsedRole = null;
        if (!string.IsNullOrWhiteSpace(role))
        {
            if (!AppUserRoleNames.All.Contains(role))
            {
                return ApiProblems.BadRequest(
                    $"Unknown role '{role}'. Expected one of: {string.Join(", ", AppUserRoleNames.All)}.");
            }
            parsedRole = AppUserRoleNames.Parse(role);
        }

        var parsedStatus = UserStatusFilter.Any;
        if (!string.IsNullOrWhiteSpace(status)
            && !Enum.TryParse(status, ignoreCase: true, out parsedStatus))
        {
            return ApiProblems.BadRequest(
                "Unknown status. Expected one of: pending, active, disabled.");
        }

        return TypedResults.Ok(
            await directory.ListUsersAsync(
                company_id, parsedRole, parsedStatus, q, after, limit, ct));
    }

    private static async Task<IResult> InviteUserAsync(
        string id, HttpContext http, PlatformDirectory directory, CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var userId))
        {
            return ApiProblems.BadRequest("The user id in the path is not a valid UUID.");
        }

        var invite = await directory.InviteAsync(userId, http.GetPrincipal().UserId, ct);

        return invite is null
            ? ApiProblems.NotFound($"No account that can hold a password was found for {userId}.")
            : TypedResults.Ok(invite);
    }

    private static Task<IResult> DisableUserAsync(
        string id, HttpContext http, PlatformDirectory directory, CancellationToken ct) =>
        SetUserDisabledAsync(id, true, http, directory, ct);

    private static Task<IResult> EnableUserAsync(
        string id, HttpContext http, PlatformDirectory directory, CancellationToken ct) =>
        SetUserDisabledAsync(id, false, http, directory, ct);

    private static async Task<IResult> SetUserDisabledAsync(
        string id, bool disabled, HttpContext http, PlatformDirectory directory, CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var userId))
        {
            return ApiProblems.BadRequest("The user id in the path is not a valid UUID.");
        }

        var user = await directory.SetUserDisabledAsync(
            userId, disabled, http.GetPrincipal().UserId, ct);

        return user is null
            ? ApiProblems.NotFound($"User {userId} was not found.")
            : TypedResults.Ok(user);
    }

    // ---------------------------------------------------------------------------------- audit

    private static async Task<IResult> ListAuditAsync(
        PlatformDirectory directory,
        CancellationToken ct,
        Guid? company_id = null,
        string? action = null,
        string? cursor = null,
        int? limit = null)
    {
        if (!TryCursor(cursor, out var after))
        {
            return BadCursor();
        }

        return TypedResults.Ok(await directory.ListAuditAsync(company_id, action, after, limit, ct));
    }

    // --------------------------------------------------------------------------------- shared

    /// <summary>
    /// No cursor is fine; a cursor that will not decode is not.
    /// <para>
    /// <b>A malformed cursor must never fall back to the first page.</b> That is how a client
    /// loops over page one forever while looking entirely healthy — every request succeeds, every
    /// page is full, and nobody notices the list has no end. A 400 says which of the two happened.
    /// </para>
    /// </summary>
    private static bool TryCursor(string? cursor, out Keyset? after)
    {
        if (string.IsNullOrWhiteSpace(cursor))
        {
            after = null;
            return true;
        }

        if (Keyset.TryDecode(cursor, out var decoded))
        {
            after = decoded;
            return true;
        }

        after = null;
        return false;
    }

    private static IResult BadCursor() => ApiProblems.BadRequest(
        "The cursor is not one this server issued. Start from the first page and follow "
        + "next_cursor.");
}
