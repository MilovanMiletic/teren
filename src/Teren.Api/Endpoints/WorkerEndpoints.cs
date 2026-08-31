using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Api.Validation;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Reporting;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

/// <summary>
/// The customer's own administrative surface: his foremen, their activation codes, and the
/// ready-made message he pastes into one man's chat.
/// <para>
/// <b>Gated to <c>company_admin</c> by <see cref="RoleFilter"/>, which is the only thing in this
/// API that emits a 403</b> — and it emits it before this file's first line runs, before an id has
/// been parsed and before a row has been read, so it cannot leak the existence of anything.
/// Inside these handlers the doctrine is unchanged: <b>another company's worker is a 404</b>,
/// identical to one that does not exist.
/// </para>
/// <para>
/// <b>There is deliberately no bulk code export</b> (§2 decision 13, §8). A code binds a device to
/// a <em>named</em> worker, so a group chat carrying six codes lets any of them activate a phone
/// under another man's name — and every entry he records is then signed with that name.
/// Attribution is the thing this whole model exists to establish.
/// </para>
/// </summary>
public static class WorkerEndpoints
{
    public static RouteGroupBuilder MapWorkerEndpoints(this RouteGroupBuilder api)
    {
        var group = api.MapGroup("/workers")
            .WithTags("Workers")
            .RequireRole(RoleGates.CompanyAdmin);

        group.MapGet("/", ListWorkersAsync)
            .WithName("ListWorkers")
            .WithSummary("The company's foremen, with device and code state.")
            .Produces<WorkerListResponse>();

        group.MapPost("/", CreateWorkerAsync)
            .AddEndpointFilter<ValidationFilter<CreateWorkerRequest>>()
            .WithName("CreateWorker")
            .WithSummary("Add a foreman and issue his first activation code.")
            .Produces<CreateWorkerResponse>(StatusCodes.Status201Created);

        group.MapPatch("/{id}", UpdateWorkerAsync)
            .AddEndpointFilter<ValidationFilter<UpdateWorkerRequest>>()
            .WithName("UpdateWorker")
            .WithSummary("Change a foreman's name, address, language, or disable him.")
            .Produces<WorkerResponse>();

        group.MapGet("/{id}/activation-code", GetActivationCodeAsync)
            .WithName("GetWorkerActivationCode")
            .WithSummary("Read the worker's live code. Reading never kills it.")
            .Produces<ActivationCodeResponse>();

        group.MapPost("/{id}/activation-code", IssueActivationCodeAsync)
            .WithName("IssueWorkerActivationCode")
            .WithSummary("Issue a fresh code, superseding whatever he had.")
            .Produces<ActivationCodeResponse>();

        group.MapGet("/{id}/share-text", GetShareTextAsync)
            .WithName("GetWorkerShareText")
            .WithSummary("The ready-made message for this one worker, in his language.")
            .Produces<ShareTextResponse>();

        return api;
    }

    // ---------------------------------------------------------------- GET /api/workers

    private static async Task<IResult> ListWorkersAsync(
        HttpContext http, TerenIdentityDbContext db, CancellationToken ct)
    {
        var companyId = http.GetPrincipal().CompanyId();
        var now = DateTime.UtcNow;

        // Projected into a flat row first and shaped afterwards: the three per-worker facts are
        // correlated subqueries the database does well, while turning a UTC DateTime into a
        // DateTimeOffset is C#. Mixing the two inside one EF projection is how a query quietly
        // becomes N+1 or stops translating.
        var rows = await db.WorkersOf(companyId)
            .AsNoTracking()
            .OrderBy(u => u.DisplayName)
            .Select(u => new
            {
                User = u,
                ActiveDevices = db.Devices.Count(d => d.UserId == u.Id && d.RevokedAt == null),
                LastSeenAt = db.Devices
                    .Where(d => d.UserId == u.Id && d.RevokedAt == null)
                    .Max(d => d.LastSeenAt),
                HasLiveCode = db.ActivationCodes.Any(c => c.UserId == u.Id
                    && c.ConsumedAt == null
                    && c.SupersededAt == null
                    && c.ExpiresAt > now),
            })
            .ToListAsync(ct);

        var workers = rows
            .Select(r => Describe(r.User, r.ActiveDevices, r.LastSeenAt, r.HasLiveCode))
            .ToList();

        return TypedResults.Ok(new WorkerListResponse(workers, workers.Count));
    }

    // ---------------------------------------------------------------- POST /api/workers

    private static async Task<IResult> CreateWorkerAsync(
        CreateWorkerRequest request,
        HttpContext http,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        ILogger<AppUser> logger,
        CancellationToken ct)
    {
        var principal = http.GetPrincipal();
        var companyId = principal.CompanyId();

        var displayName = (request.DisplayName ?? string.Empty).Trim();

        string? email = null;
        if (!string.IsNullOrWhiteSpace(request.Email)
            && !EmailAddress.TryNormalise(request.Email, out email))
        {
            return ApiProblems.BadRequest("email does not look like an email address.");
        }

        string username;

        if (string.IsNullOrWhiteSpace(request.Username))
        {
            var seed = UsernameFormat.Propose(displayName);

            if (!UsernameFormat.IsValid(seed))
            {
                return ApiProblems.BadRequest(
                    "username could not be derived from display_name; send one explicitly.");
            }

            username = await NextFreeUsernameAsync(db, seed, ct);
        }
        else
        {
            username = UsernameFormat.Normalise(request.Username);

            if (!UsernameFormat.IsValid(username))
            {
                return ApiProblems.BadRequest(
                    "username must be 3–64 characters of lowercase letters, digits, and single "
                    + "'.', '-' or '_' between them.");
            }

            // Usernames are globally unique, not per-company (§4): the self-service flow looks a
            // worker up by username alone and must not have to ask "which company?". So this
            // check — and this 409 — reach across tenants, which is a small, deliberate departure
            // from "foreign is indistinguishable from nonexistent". It is unavoidable in a global
            // namespace: without it the unique index raises instead. It is also why the ordinary
            // path is to let the server PROPOSE a name, which never produces this answer at all.
            if (await db.Users.AnyAsync(u => u.Username == username, ct))
            {
                return ApiProblems.Conflict(
                    ApiProblemCodes.UsernameTaken,
                    $"The username '{username}' is already in use. Leave username out and the "
                    + "server will propose a free one.");
            }
        }

        var now = DateTime.UtcNow;
        var worker = new AppUser
        {
            Id = Guid.NewGuid(),
            CompanyId = companyId,
            Role = AppUserRole.Worker,
            Username = username,
            DisplayName = displayName,
            Email = email,
            // A worker never has a password. The database agrees:
            // ck_app_user_worker_has_no_password.
            PasswordHash = null,
            Language = LanguageOf(request.Language),
            CreatedAt = now,
        };

        // One transaction: a worker who exists but has no code is an onboarding the admin cannot
        // finish, and he would have to notice that for himself.
        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        db.Users.Add(worker);
        db.AdminAudits.Add(new AdminAudit
        {
            Id = Guid.NewGuid(),
            ActorUserId = principal.UserId,
            Action = AdminAuditActions.WorkerCreated,
            SubjectType = "app_user",
            SubjectId = worker.Id,
            CompanyId = companyId,
            CreatedAt = now,
        });

        await db.SaveChangesAsync(ct);

        var code = await ActivationCodes.IssueAsync(
            db,
            worker,
            principal.UserId,
            AdminAuditActions.ActivationCodeIssued,
            options.Value.ActivationCodeLifetime,
            ct);

        await transaction.CommitAsync(ct);

        logger.LogInformation(
            "Worker {UserId} created for company {CompanyId} with a first activation code.",
            worker.Id, companyId);

        return TypedResults.Created(
            $"/api/workers/{worker.Id}",
            new CreateWorkerResponse(Describe(worker, activeDevices: 0, lastSeenAt: null,
                hasLiveCode: true), code));
    }

    // ---------------------------------------------------------------- PATCH /api/workers/{id}

    private static async Task<IResult> UpdateWorkerAsync(
        string id,
        UpdateWorkerRequest request,
        HttpContext http,
        TerenIdentityDbContext db,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var workerId))
        {
            return ApiProblems.BadRequest("The worker id in the path is not a valid UUID.");
        }

        var principal = http.GetPrincipal();
        var companyId = principal.CompanyId();

        var worker = await db.WorkerOrNullAsync(companyId, workerId, ct);
        if (worker is null)
        {
            return ApiProblems.NotFound($"Worker {workerId} was not found.");
        }

        if (request.DisplayName is not null)
        {
            var displayName = request.DisplayName.Trim();
            if (displayName.Length == 0)
            {
                return ApiProblems.BadRequest("display_name cannot be blank.");
            }

            worker.DisplayName = displayName;
        }

        if (request.Email is not null)
        {
            // An empty string clears the address; an absent field leaves it alone. JSON cannot
            // tell "absent" from "null" through a `string?`, and inventing a wrapper type to
            // recover the distinction would cost more than it is worth here.
            if (request.Email.Trim().Length == 0)
            {
                worker.Email = null;
            }
            else if (EmailAddress.TryNormalise(request.Email, out var email))
            {
                worker.Email = email;
            }
            else
            {
                return ApiProblems.BadRequest("email does not look like an email address.");
            }
        }

        if (request.Language is not null)
        {
            worker.Language = LanguageOf(request.Language);
        }

        var now = DateTime.UtcNow;
        string? action = null;

        if (request.Disabled is bool disabled && (worker.DisabledAt is not null) != disabled)
        {
            // "Remove a worker" is this stamp and never a DELETE: every foreign key into app_user
            // is RESTRICT, because a man who authored evidence has to stay nameable. His phones
            // are deliberately NOT revoked here — the authenticator already refuses a disabled
            // user on the next request, and leaving the device rows alone keeps the provenance
            // trail honest about which phone recorded what.
            worker.DisabledAt = disabled ? now : null;
            action = disabled
                ? AdminAuditActions.WorkerDisabled
                : AdminAuditActions.WorkerEnabled;
        }

        db.AdminAudits.Add(new AdminAudit
        {
            Id = Guid.NewGuid(),
            ActorUserId = principal.UserId,
            Action = action ?? AdminAuditActions.WorkerUpdated,
            SubjectType = "app_user",
            SubjectId = worker.Id,
            CompanyId = companyId,
            CreatedAt = now,
        });

        await db.SaveChangesAsync(ct);

        return TypedResults.Ok(await DescribeAsync(db, worker, ct));
    }

    // -------------------------------------------- GET|POST /api/workers/{id}/activation-code

    private static async Task<IResult> GetActivationCodeAsync(
        string id, HttpContext http, TerenIdentityDbContext db, CancellationToken ct)
    {
        var (worker, failure) = await ResolveWorkerAsync(id, http, db, ct);
        if (worker is null)
        {
            return failure!;
        }

        var code = await ActivationCodes.LiveAsync(db, worker, ct);

        return code is null ? NoLiveCode(worker.Id) : TypedResults.Ok(code);
    }

    private static async Task<IResult> IssueActivationCodeAsync(
        string id,
        HttpContext http,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        CancellationToken ct)
    {
        var (worker, failure) = await ResolveWorkerAsync(id, http, db, ct);
        if (worker is null)
        {
            return failure!;
        }

        if (worker.DisabledAt is not null)
        {
            return ApiProblems.Conflict(
                $"Worker {worker.Id} is disabled; enable him before issuing a code.");
        }

        var code = await ActivationCodes.IssueAsync(
            db,
            worker,
            http.GetPrincipal().UserId,
            AdminAuditActions.ActivationCodeIssued,
            options.Value.ActivationCodeLifetime,
            ct);

        return TypedResults.Ok(code);
    }

    // ------------------------------------------------- GET /api/workers/{id}/share-text

    private static async Task<IResult> GetShareTextAsync(
        string id,
        HttpContext http,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        CancellationToken ct)
    {
        var (worker, failure) = await ResolveWorkerAsync(id, http, db, ct);
        if (worker is null)
        {
            return failure!;
        }

        var code = await ActivationCodes.LiveAsync(db, worker, ct);
        if (code is null)
        {
            // Deliberately does NOT issue one. A GET that quietly supersedes the code the worker
            // is holding is exactly the operational trap §5 reversed the "hash only" design to
            // avoid.
            return NoLiveCode(worker.Id);
        }

        var strings = InviteStrings.For(worker.Language);

        var text = strings.WorkerActivationMessage(
            worker.DisplayName,
            worker.Username!,
            code.Code,
            code.ExpiresAt.UtcDateTime,
            // The market's zone. Projects carry their own for reports; a person does not carry
            // one, and an expiry date printed a day out is a support call.
            ReportTimeZone.Resolve(ReportTimeZone.Default),
            options.Value.AppUrl);

        return TypedResults.Ok(new ShareTextResponse(text, strings.Language, code));
    }

    // ---------------------------------------------------------------- shared

    private static async Task<(AppUser? Worker, IResult? Failure)> ResolveWorkerAsync(
        string id, HttpContext http, TerenIdentityDbContext db, CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var workerId))
        {
            return (null, ApiProblems.BadRequest("The worker id in the path is not a valid UUID."));
        }

        var worker = await db.WorkerOrNullAsync(http.GetPrincipal().CompanyId(), workerId, ct);

        return worker is null
            ? (null, ApiProblems.NotFound($"Worker {workerId} was not found."))
            : (worker, null);
    }

    private static IResult NoLiveCode(Guid workerId) => ApiProblems.Conflict(
        ApiProblemCodes.NoLiveActivationCode,
        $"Worker {workerId} has no live activation code. POST to this route to issue one.");

    /// <summary>
    /// Only two languages exist in the product, and an unknown value silently becoming Serbian is
    /// how a foreman ends up with a screen he cannot read. Anything unrecognised falls back to the
    /// default, which is what <see cref="InviteStrings.For"/> would do with it anyway.
    /// </summary>
    private static string LanguageOf(string? requested)
    {
        var language = (requested ?? string.Empty).Trim().ToLowerInvariant();

        return language is "en" ? "en" : InviteStrings.DefaultLanguage;
    }

    private static async Task<string> NextFreeUsernameAsync(
        TerenIdentityDbContext db, string seed, CancellationToken ct)
    {
        // Small and bounded: the alternative is asking the admin to fight a "taken" error, which
        // is the exact experience §4 designed the proposal to avoid.
        var taken = await db.Users
            .AsNoTracking()
            .Where(u => u.Username != null && u.Username.StartsWith(seed))
            .Select(u => u.Username!)
            .ToListAsync(ct);

        var lookup = taken.ToHashSet(StringComparer.Ordinal);

        return UsernameFormat.NextFree(seed, lookup.Contains);
    }

    private static async Task<WorkerResponse> DescribeAsync(
        TerenIdentityDbContext db, AppUser worker, CancellationToken ct)
    {
        var now = DateTime.UtcNow;

        var devices = await db.Devices
            .AsNoTracking()
            .Where(d => d.UserId == worker.Id && d.RevokedAt == null)
            .Select(d => d.LastSeenAt)
            .ToListAsync(ct);

        var hasLiveCode = await db.ActivationCodes
            .AsNoTracking()
            .AnyAsync(
                c => c.UserId == worker.Id
                    && c.ConsumedAt == null
                    && c.SupersededAt == null
                    && c.ExpiresAt > now,
                ct);

        return Describe(
            worker,
            devices.Count,
            devices.Where(d => d is not null).Max(),
            hasLiveCode);
    }

    private static WorkerResponse Describe(
        AppUser worker, int activeDevices, DateTime? lastSeenAt, bool hasLiveCode) =>
        new(
            worker.Id,
            worker.Username!,
            worker.DisplayName,
            worker.Email,
            worker.Language,
            new DateTimeOffset(DateTime.SpecifyKind(worker.CreatedAt, DateTimeKind.Utc)),
            worker.DisabledAt is null
                ? null
                : new DateTimeOffset(DateTime.SpecifyKind(worker.DisabledAt.Value, DateTimeKind.Utc)),
            activeDevices,
            lastSeenAt is null
                ? null
                : new DateTimeOffset(DateTime.SpecifyKind(lastSeenAt.Value, DateTimeKind.Utc)),
            hasLiveCode);
}
