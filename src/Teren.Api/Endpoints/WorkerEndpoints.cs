using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Options;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Api.Validation;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Reporting;
using Teren.Core.Text;
using Teren.Core.Time;
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

    /// <summary>
    /// Adds a foreman and issues his first activation code.
    /// <para>
    /// <b>Both unique indexes this touches are global, and neither can be checked atomically from
    /// C#.</b> <c>ux_app_user_username</c> and <c>ux_app_user_email</c> span every company, so a
    /// look-then-insert always has a window: two admins adding a "Zoran Jovanović" in the same
    /// second both propose <c>zoran.jovanovic</c>, and one of the inserts is refused. Before this
    /// handler caught them, that window was a 500. The discipline is the one
    /// <c>EntryEndpoints</c> already follows for <c>pk_entry</c> — let the database settle it and
    /// translate the violation into an answer.
    /// </para>
    /// </summary>
    private static async Task<IResult> CreateWorkerAsync(
        CreateWorkerRequest request,
        HttpContext http,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        Core.Mail.IMailSender mail,
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

        // Null means "the admin did not name one, so the server proposes" — and that difference
        // decides what happens when the insert loses a race below.
        var chosen = string.IsNullOrWhiteSpace(request.Username)
            ? null
            : UsernameFormat.Normalise(request.Username);

        if (chosen is not null && !UsernameFormat.IsValid(chosen))
        {
            return ApiProblems.BadRequest(
                "username must be 3–64 characters of lowercase letters, digits, and single "
                + "'.', '-' or '_' between them.");
        }

        var seed = chosen is null ? UsernameFormat.Propose(displayName) : null;

        if (seed is not null && !UsernameFormat.IsValid(seed))
        {
            return ApiProblems.BadRequest(
                "username could not be derived from display_name; send one explicitly.");
        }

        for (var attempt = 0; ; attempt++)
        {
            var username = chosen ?? await NextFreeUsernameAsync(db, seed!, ct);

            // Usernames are globally unique, not per-company (§4): the self-service flow looks a
            // worker up by username alone and must not have to ask "which company?". So this
            // check — and this 409 — reach across tenants, which is a small, deliberate departure
            // from "foreign is indistinguishable from nonexistent". It is unavoidable in a global
            // namespace. It is also why the ordinary path is to let the server PROPOSE a name,
            // which never produces this answer at all.
            if (chosen is not null && await db.Users.AnyAsync(u => u.Username == chosen, ct))
            {
                return UsernameTaken(chosen);
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

            // One transaction: a worker who exists but has no code is an onboarding the admin
            // cannot finish, and he would have to notice that for himself.
            await using var transaction = await db.Database.BeginTransactionAsync(ct);

            db.Users.Add(worker);
            db.AdminAudits.Add(AdminAudit.For(
                principal.UserId,
                AdminAuditActions.WorkerCreated,
                "app_user",
                worker.Id,
                companyId,
                now));

            try
            {
                await db.SaveChangesAsync(ct);

                var code = await ActivationCodes.IssueAsync(
                    db,
                    worker,
                    principal.UserId,
                    AdminAuditActions.ActivationCodeIssued,
                    options.Value.ActivationCodeLifetime,
                    mail.IsConfigured,
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
            catch (DbUpdateException ex) when (PostgresErrors.IsUniqueViolation(ex, "ux_app_user_username"))
            {
                await RewindAsync(db, transaction, ct);

                // An explicitly requested name belongs to the admin, so losing the race gives him
                // exactly the answer the pre-check above would have: try another. A PROPOSED name
                // belongs to the server, so it proposes the next one instead — the admin never
                // sees a fight he did not pick. One retry only: a second loss means contention
                // this handler should not be papering over.
                if (chosen is not null)
                {
                    return UsernameTaken(username);
                }

                if (attempt > 0)
                {
                    // He did not pick a username, so telling him to leave it out is advice he has
                    // already taken. The server's own second proposal lost too, which is not his
                    // problem to solve — it is a retry.
                    return ProposalLost(username);
                }
            }
            catch (DbUpdateException ex) when (PostgresErrors.IsUniqueViolation(ex, "ux_app_user_email"))
            {
                await RewindAsync(db, transaction, ct);
                return EmailTaken();
            }
        }
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

        db.AdminAudits.Add(AdminAudit.For(
            principal.UserId,
            action ?? AdminAuditActions.WorkerUpdated,
            "app_user",
            worker.Id,
            companyId,
            now));

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (PostgresErrors.IsUniqueViolation(ex, "ux_app_user_email"))
        {
            // ux_app_user_email is global and partial: the address may belong to another
            // company's admin, so there is nothing this handler could have read to see it coming.
            // The answer is a 409 the admin can act on rather than a 500 he can only report.
            db.ChangeTracker.Clear();
            return EmailTaken();
        }

        return TypedResults.Ok(await DescribeAsync(db, worker, ct));
    }

    // -------------------------------------------- GET|POST /api/workers/{id}/activation-code

    private static async Task<IResult> GetActivationCodeAsync(
        string id,
        HttpContext http,
        TerenIdentityDbContext db,
        Core.Mail.IMailSender mail,
        CancellationToken ct)
    {
        var (worker, failure) = await ResolveWorkerAsync(id, http, db, ct);
        if (worker is null)
        {
            return failure!;
        }

        var code = await ActivationCodes.LiveAsync(db, worker, mail.IsConfigured, ct);

        return code is null ? NoLiveCode(worker.Id) : TypedResults.Ok(code);
    }

    private static async Task<IResult> IssueActivationCodeAsync(
        string id,
        HttpContext http,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        Core.Mail.IMailSender mail,
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
            mail.IsConfigured,
            ct);

        return TypedResults.Ok(code);
    }

    // ------------------------------------------------- GET /api/workers/{id}/share-text

    private static async Task<IResult> GetShareTextAsync(
        string id,
        HttpContext http,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        Core.Mail.IMailSender mail,
        CancellationToken ct)
    {
        var (worker, failure) = await ResolveWorkerAsync(id, http, db, ct);
        if (worker is null)
        {
            return failure!;
        }

        var code = await ActivationCodes.LiveAsync(db, worker, mail.IsConfigured, ct);
        if (code is null)
        {
            // Deliberately does NOT issue one. A GET that quietly supersedes the code the worker
            // is holding is exactly the operational trap §5 reversed the "hash only" design to
            // avoid.
            return NoLiveCode(worker.Id);
        }

        var strings = WorkerInviteStrings.For(worker.Language);

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

    private static IResult UsernameTaken(string username) => ApiProblems.Conflict(
        ApiProblemCodes.UsernameTaken,
        $"The username '{username}' is already in use. Leave username out and the server will "
        + "propose a free one.");

    /// <summary>
    /// The other arm of the same 409: the admin named nobody, and the server's proposal lost a
    /// race twice. Same problem <c>code</c> deliberately — a client branches on one value for
    /// "this name is gone" and both arms mean that — but the detail must not tell a man to do the
    /// thing he already did.
    /// </summary>
    private static IResult ProposalLost(string username) => ApiProblems.Conflict(
        ApiProblemCodes.UsernameTaken,
        $"The username '{username}' was taken by another request while this worker was being "
        + "created. Nothing was saved; send the same request again.");

    /// <summary>
    /// Deliberately does <b>not</b> repeat the address back. Unlike a username, which the admin
    /// just typed and has to be told about to pick another, an address is somebody's personal
    /// data and it may belong to a person in another company entirely — the reply says the field
    /// is the problem, and nothing about whose it is.
    /// </summary>
    private static IResult EmailTaken() => ApiProblems.Conflict(
        ApiProblemCodes.EmailTaken,
        "That email address is already registered to a Teren account. Leave email out, or use "
        + "another address.");

    /// <summary>
    /// Undoes a lost insert race so the next attempt starts clean: the transaction goes back, and
    /// the entities it had added stop being tracked — otherwise the retry re-sends them.
    /// </summary>
    private static async Task RewindAsync(
        TerenIdentityDbContext db, IDbContextTransaction transaction, CancellationToken ct)
    {
        await transaction.RollbackAsync(ct);
        db.ChangeTracker.Clear();
    }

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
    /// default, which is what <see cref="WorkerInviteStrings.For"/> would do with it anyway — and
    /// since 2026-09-02 it is literally the same rule rather than a fourth copy of it
    /// (<see cref="LanguageTag"/>): this one used to accept <c>en</c> alone while the readers of
    /// the column accepted <c>en-GB</c> too, so what was stored and what was understood could
    /// disagree about the same word.
    /// </summary>
    private static string LanguageOf(string? requested) => LanguageTag.Of(requested);

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
            UtcStamp.Of(worker.CreatedAt),
            UtcStamp.OrNull(worker.DisabledAt),
            activeDevices,
            UtcStamp.OrNull(lastSeenAt),
            hasLiveCode);
}
