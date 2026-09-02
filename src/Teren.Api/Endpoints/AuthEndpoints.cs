using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Api.Jobs;
using Teren.Api.Validation;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

/// <summary>
/// The unauthenticated door: activation, login, and setting a password.
/// <para>
/// <b>These routes live under <c>/auth</c>, deliberately NOT under <c>/api</c></b> (§8), so that
/// <c>TenancyTests.Every_api_route_sits_behind_the_token</c> stays <em>literally</em> true rather
/// than "true with exceptions". An exception list on the one test that proves nothing is
/// reachable anonymously is how that test stops being worth running.
/// </para>
/// <para>
/// <b>Nothing here may be an enumeration oracle.</b> A login surface that answers differently for
/// "no such account" and "wrong password" hands an attacker a customer list, and this codebase
/// already goes to the trouble of making a foreign media id 404 rather than 409. So: login runs
/// <see cref="PasswordHash.DummyVerify"/> on the unknown-email path so both answers cost the same
/// wall clock, every activation failure is byte-identical, and
/// <c>POST /auth/activation-code</c> answers 202 whether or not the username exists.
/// </para>
/// <para>
/// The whole group sits behind a fixed-window IP rate limiter (<see cref="AuthRateLimitPolicy"/>).
/// </para>
/// </summary>
public static class AuthEndpoints
{
    public static RouteGroupBuilder MapAuthEndpoints(this RouteGroupBuilder auth)
    {
        auth.MapPost("/activate", ActivateAsync)
            .AddEndpointFilter<ValidationFilter<ActivateRequest>>()
            .WithName("ActivateDevice")
            .WithSummary("Bind a phone to a worker with his username and a one-time code.")
            .Produces<ActivateResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        auth.MapPost("/activation-code", RequestActivationCodeAsync)
            .AddEndpointFilter<ValidationFilter<ActivationCodeRequestBody>>()
            .WithName("RequestActivationCode")
            .WithSummary("Ask for a fresh code by username. Always 202, whatever the username is.")
            .Produces(StatusCodes.Status202Accepted);

        auth.MapPost("/login", LoginAsync)
            .AddEndpointFilter<ValidationFilter<LoginRequest>>()
            .WithName("Login")
            .WithSummary("Sign an admin in with email and password.")
            .Produces<LoginResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        auth.MapPost("/password", SetPasswordAsync)
            .AddEndpointFilter<ValidationFilter<SetPasswordRequest>>()
            .WithName("SetPassword")
            .WithSummary("Set a password from an invite or reset token. Serves both.")
            .Produces<SetPasswordResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        return auth;
    }

    // ---------------------------------------------------------------- POST /auth/activate

    /// <summary>
    /// Binds a phone to a worker with his username and a one-time code.
    /// <para>
    /// <b>Read the shape of this handler before changing it: it has no early returns, and that is
    /// deliberate.</b> A malformed code, an unknown username, a suspended company and a wrong code
    /// all run <em>the same four statements</em> and are refused only at the end. Returning as
    /// soon as each is known would be the obvious code and would also be an account-enumeration
    /// oracle by stopwatch — the very thing <see cref="PasswordHash.DummyVerify"/> exists to close
    /// on the login route. See the note on <see cref="InvalidActivation"/>.
    /// </para>
    /// </summary>
    private static async Task<IResult> ActivateAsync(
        ActivateRequest request,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        ILogger<Device> logger,
        CancellationToken ct)
    {
        // Folded before it is hashed, so a code typed with dashes, in lower case, or with the
        // Cyrillic О a man's keyboard produced still resolves to the same 8 characters.
        var parsed = ActivationCodeFormat.TryParse(request.ActivationCode, out var code);

        var username = UsernameFormat.Normalise(request.Username);
        var now = DateTime.UtcNow;

        var worker = await db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(
                u => u.Username == username
                    && u.Role == AppUserRole.Worker
                    && u.DisabledAt == null,
                ct);

        // Guid.Empty rather than a return: the company lookup has to run for an unknown username
        // too, or "does this man work here" is answered by one missing round trip. No company row
        // can carry it — every id in the product is generated — so the query costs the same and
        // finds nothing.
        var companyId = worker?.CompanyId ?? Guid.Empty;

        var company = await db.Companies
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == companyId && c.SuspendedAt == null, ct);

        var admissible = parsed && worker is not null && company is not null;

        // Every failure above is carried forward as "the claim cannot match" instead of as a
        // return. NoSuchCodeHash is 64 zeros — a SHA-256 output nobody can produce a preimage
        // for — so a request that got this far on a bad username cannot consume anybody's code
        // even if the sentinel user id ever collided with a real row.
        var claimUserId = admissible ? worker!.Id : Guid.Empty;
        var claimHash = admissible ? CredentialTokens.Hash(code!) : NoSuchCodeHash;

        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        // THE CLAIM, and it is the whole reason a code is single-use in practice and not merely
        // in intent. Conditional, so two phones racing one code are settled by the database: the
        // second UPDATE blocks on the row lock, re-evaluates the predicate after the first
        // commits, and matches nothing. Exactly one phone, every time — proven by
        // ActivationRaceTests, not hoped for.
        //
        // It is also the FIRST statement in the transaction, which it did not use to be. The
        // device row is written only after the claim succeeds, because inserting the phone first
        // meant a wrong code cost an INSERT, a failed UPDATE and a ROLLBACK that an unknown
        // username did not — a measurable answer to "does this username exist and is it active".
        var claimed = await db.ActivationCodes
            .Where(c => c.UserId == claimUserId
                && c.CodeHash == claimHash
                && c.ConsumedAt == null
                && c.SupersededAt == null
                && c.ExpiresAt > now)
            .ExecuteUpdateAsync(
                u => u
                    .SetProperty(c => c.ConsumedAt, now)
                    // A dead code cannot still be holding plaintext
                    // (ck_activation_code_display_cleared).
                    .SetProperty(c => c.CodeDisplay, (string?)null),
                ct);

        if (claimed == 0)
        {
            // Malformed code, unknown username, disabled worker, suspended company, wrong code,
            // expired code, superseded code, or someone else took it a millisecond ago. All of
            // them are one answer, reached down one path, after the same work: which of them it
            // was is exactly what an attacker would like to know.
            await transaction.RollbackAsync(ct);
            return InvalidActivation();
        }

        var deviceId = Guid.NewGuid();
        var deviceToken = CredentialTokens.New(CredentialTokens.DevicePrefix);
        var deviceName = DeviceNameOf(request.DeviceName, worker!.DisplayName);

        db.Devices.Add(new Device
        {
            Id = deviceId,
            CompanyId = companyId,
            UserId = worker.Id,
            Name = deviceName,
            TokenHash = CredentialTokens.Hash(deviceToken),
            CreatedAt = now,
            LastSeenAt = now,
        });

        await db.SaveChangesAsync(ct);

        // consumed_device_id is a foreign key, so the phone has to exist before the code can point
        // at it — which is why this is a second statement rather than part of the claim. The row
        // it names is unambiguous: ux_activation_code_live means the claim above matched at most
        // one row, this transaction still holds its lock, and no other transaction can have
        // stamped consumed_at with the identical instant.
        await db.ActivationCodes
            .Where(c => c.UserId == worker.Id
                && c.CodeHash == claimHash
                && c.ConsumedAt == now
                && c.ConsumedDeviceId == null)
            .ExecuteUpdateAsync(
                u => u.SetProperty(c => c.ConsumedDeviceId, (Guid?)deviceId), ct);

        // A worker moves to a replacement phone by activating it (§2 decision 14), so not
        // revoking the old one would leave a lost or stolen phone recording under his name
        // indefinitely. Same transaction as the claim: there is no instant at which he has two.
        var superseded = await db.Devices
            .Where(d => d.UserId == worker.Id && d.Id != deviceId && d.RevokedAt == null)
            .ExecuteUpdateAsync(
                u => u
                    .SetProperty(d => d.RevokedAt, now)
                    .SetProperty(d => d.RevokedByUserId, (Guid?)worker.Id),
                ct);

        db.AdminAudits.Add(Audit(
            AdminAuditActions.DeviceActivated, worker.Id, companyId, "device", deviceId, now));

        if (superseded > 0)
        {
            // Distinguished from an admin pressing revoke, so "who took this phone away" has a
            // truthful answer six months from now.
            db.AdminAudits.Add(Audit(
                AdminAuditActions.DeviceSuperseded, worker.Id, companyId, "app_user", worker.Id,
                now, $$"""{"superseded_devices": {{superseded}}}"""));
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);

        logger.LogInformation(
            "Device {DeviceId} activated for user {UserId}; {SupersededCount} previous device(s) "
            + "revoked.", deviceId, worker.Id, superseded);

        return TypedResults.Ok(new ActivateResponse(
            deviceToken,
            deviceId,
            deviceName,
            worker.Id,
            worker.Username!,
            worker.DisplayName,
            worker.Language,
            new CompanyRefResponse(company!.Id, company.Name)));
    }

    // -------------------------------------------------------- POST /auth/activation-code

    /// <summary>
    /// Decision 14's self-service path: a man standing next to a broken phone types his username
    /// and a fresh code goes to his address.
    /// <para>
    /// <b>Always 202, and always the same body.</b> The screen says "if that username exists, a
    /// code is on its way", because a login surface must not be an account-enumeration oracle —
    /// and the honest degradation for a worker with no address on file ("ask your boss") is
    /// resolved at <em>invite</em> time, where it can be said without confirming anything at
    /// runtime.
    /// </para>
    /// <para>
    /// <b>THIS REQUEST WRITES NOTHING, and that is the fix of 2026-09-02.</b> It used to mint here
    /// — supersede the worker's live code and insert a fresh one — and then log a
    /// <c>TODO(D6)</c> where the mail should have gone. So an unauthenticated caller who knew a
    /// username, and usernames are guessable (<c>UsernameFormat.Propose</c> derives one from a
    /// display name; company and worker names are public), could invalidate the code a foreman was
    /// about to type on a site, and produce nothing in its place. The mint now lives inside
    /// <see cref="Jobs.WorkerCodeMailJob"/>, past every reason not to send, so a request that
    /// cannot mail supersedes nothing.
    /// </para>
    /// <para>
    /// <b>The job is enqueued unconditionally, and that is what keeps the answer uniform.</b>
    /// Deciding eligibility here would put a supersede, an insert and an audit row on one branch
    /// and nothing on the other, which §10.3 requires to stay invisible <em>at runtime</em> — it
    /// is the leak <c>ActivationCodes.BurnIssueCostAsync</c> existed to compensate for, by
    /// spending statements on purpose. With no branch there is nothing to compensate: two lookups
    /// and one enqueue, whoever asked. The job resolves the same user id again and does the whole
    /// decision where a stopwatch cannot reach it.
    /// </para>
    /// </summary>
    private static async Task<IResult> RequestActivationCodeAsync(
        ActivationCodeRequestBody request,
        TerenIdentityDbContext db,
        IInviteQueue mailJobs,
        ILogger<ActivationCode> logger,
        CancellationToken ct)
    {
        var username = UsernameFormat.Normalise(request.Username);

        // Deliberately not short-circuited on an empty or unknown username, and the company
        // lookup below is deliberately not short-circuited either: a request that skips a round
        // trip is answered measurably sooner, and this route's whole promise is that the answer
        // is the same either way. Byte-identical was never enough on its own.
        var worker = await db.Users.AsNoTracking().FirstOrDefaultAsync(
            u => u.Username == username
                && u.Role == AppUserRole.Worker
                && u.DisabledAt == null,
            ct);

        var companyId = worker?.CompanyId ?? Guid.Empty;

        // Read here as well as in the job, even though the job's read is the one that decides:
        // dropping it would make an unknown username one round trip cheaper than a known one.
        await db.Companies.AnyAsync(c => c.Id == companyId && c.SuspendedAt == null, ct);

        // Guid.Empty for an unknown username — the job returns immediately on it. An id, never
        // the name that was typed: a Hangfire argument is serialised into its storage and kept in
        // job history (ARCHITECTURE §12).
        mailJobs.EnqueueWorkerCodeMail(worker?.Id ?? Guid.Empty);

        logger.LogInformation(
            "Activation-code mail requested for {UserId}; nothing is minted until the job has "
            + "somewhere to send it.", worker?.Id ?? Guid.Empty);

        // Byte-identical whether or not anything happens in the job.
        return TypedResults.Accepted((string?)null);
    }

    // ---------------------------------------------------------------- POST /auth/login

    private static async Task<IResult> LoginAsync(
        LoginRequest request,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        ILogger<AdminSession> logger,
        CancellationToken ct)
    {
        var email = EmailAddress.Normalise(request.Email);
        var password = request.Password ?? string.Empty;

        var user = email.Length == 0
            ? null
            : await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email == email, ct);

        if (user?.PasswordHash is null)
        {
            // Burns the same wall clock a real verify would. Without this, "no such account"
            // returns in microseconds and "wrong password" in a few hundred milliseconds, and
            // login is an enumeration oracle by stopwatch. It also covers the worker case: a
            // worker can never have a password (ck_app_user_worker_has_no_password), so his row
            // lands here and answers exactly as an unknown address does.
            PasswordHash.DummyVerify(password);
            return InvalidLogin();
        }

        if (!PasswordHash.Verify(password, user.PasswordHash))
        {
            return InvalidLogin();
        }

        // Everything below is a withdrawal of an otherwise-good credential, and every one of them
        // is the same 401 as a wrong password: "disabled" and "suspended" are oracles too.
        if (user.DisabledAt is not null || user.Role == AppUserRole.Worker)
        {
            return InvalidLogin();
        }

        CompanyRefResponse? company = null;

        if (user.CompanyId is Guid companyId)
        {
            var row = await db.Companies
                .AsNoTracking()
                .FirstOrDefaultAsync(c => c.Id == companyId && c.SuspendedAt == null, ct);

            if (row is null)
            {
                return InvalidLogin();
            }

            company = new CompanyRefResponse(row.Id, row.Name);
        }

        var now = DateTime.UtcNow;
        var token = CredentialTokens.New(CredentialTokens.SessionPrefix);
        var expiresAt = now.Add(options.Value.SessionLifetimeFor(user.Role));

        db.AdminSessions.Add(new AdminSession
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = CredentialTokens.Hash(token),
            CreatedAt = now,
            LastSeenAt = now,
            ExpiresAt = expiresAt,
        });

        await db.SaveChangesAsync(ct);

        await db.Users
            .Where(u => u.Id == user.Id)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.LastLoginAt, now), ct);

        // The role and the id, never the address: this line goes to the log stream a super admin
        // will be able to read at D5.
        logger.LogInformation(
            "User {UserId} ({Role}) signed in; session expires {ExpiresAt:O}.",
            user.Id, AppUserRoleNames.ToWire(user.Role), expiresAt);

        return TypedResults.Ok(new LoginResponse(
            token,
            new DateTimeOffset(DateTime.SpecifyKind(expiresAt, DateTimeKind.Utc)),
            AppUserRoleNames.ToWire(user.Role),
            user.Id,
            user.DisplayName,
            company));
    }

    // ---------------------------------------------------------------- POST /auth/password

    private static async Task<IResult> SetPasswordAsync(
        SetPasswordRequest request,
        TerenIdentityDbContext db,
        ILogger<PasswordToken> logger,
        CancellationToken ct)
    {
        var tokenHash = CredentialTokens.Hash(request.Token ?? string.Empty);
        var now = DateTime.UtcNow;

        var pending = await db.PasswordTokens
            .AsNoTracking()
            .Where(t => t.TokenHash == tokenHash
                && t.ConsumedAt == null
                && t.SupersededAt == null
                && t.ExpiresAt > now)
            .Select(t => new { t.Id, t.UserId })
            .FirstOrDefaultAsync(ct);

        if (pending is null)
        {
            return InvalidToken();
        }

        var user = await db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == pending.UserId && u.DisabledAt == null, ct);

        // A worker with a password would be a second door into the diary, and the database
        // refuses to store one anyway (ck_app_user_worker_has_no_password). Refusing here means
        // the answer is a 401 rather than a 500 from a CHECK.
        if (user is null || user.Role == AppUserRole.Worker || user.Email is null)
        {
            return InvalidToken();
        }

        // ~200–400 ms by design (600 000 PBKDF2 iterations). Deliberately outside the transaction
        // so a slow hash is not a held row lock.
        var hashed = PasswordHash.Hash(request.Password!);

        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        var consumed = await db.PasswordTokens
            .Where(t => t.Id == pending.Id
                && t.ConsumedAt == null
                && t.SupersededAt == null
                && t.ExpiresAt > now)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.ConsumedAt, now), ct);

        if (consumed == 0)
        {
            // Single use, settled by the database rather than by a read-then-write.
            await transaction.RollbackAsync(ct);
            return InvalidToken();
        }

        await db.Users
            .Where(u => u.Id == user.Id)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.PasswordHash, hashed), ct);

        // Setting a password ends every session that was opened with the old one. The reset path
        // exists precisely for the case where somebody else may hold a credential.
        await db.AdminSessions
            .Where(s => s.UserId == user.Id && s.RevokedAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.RevokedAt, now), ct);

        db.AdminAudits.Add(Audit(
            AdminAuditActions.PasswordSet, user.Id, user.CompanyId, "app_user", user.Id, now));

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);

        logger.LogInformation("Password set for user {UserId}; existing sessions revoked.", user.Id);

        return TypedResults.Ok(new SetPasswordResponse(
            user.Email, AppUserRoleNames.ToWire(user.Role)));
    }

    // ---------------------------------------------------------------- shared

    /// <summary>
    /// A <c>code_hash</c> no activation code can ever carry, used to make the claim statement run
    /// — and match nothing — on a request that is already doomed. 64 zeros is a well-formed
    /// SHA-256 output with no known preimage, so it is safe in the strong sense rather than merely
    /// unlikely.
    /// </summary>
    private static readonly string NoSuchCodeHash = new('0', CredentialTokens.HashLength);

    /// <summary>
    /// A name for the phone, so the admin's device list is legible. Falls back to the worker's own
    /// name rather than refusing to activate a phone over a missing label — the man is standing on
    /// a site trying to start work.
    /// </summary>
    private static string DeviceNameOf(string? requested, string displayName)
    {
        var name = (requested ?? string.Empty).Trim();

        if (name.Length == 0)
        {
            return displayName;
        }

        return name.Length > 120 ? name[..120] : name;
    }

    private static AdminAudit Audit(
        string action,
        Guid actorUserId,
        Guid? companyId,
        string subjectType,
        Guid subjectId,
        DateTime now,
        string? detail = null) => new()
        {
            Id = Guid.NewGuid(),
            ActorUserId = actorUserId,
            Action = action,
            SubjectType = subjectType,
            SubjectId = subjectId,
            CompanyId = companyId,
            Detail = detail,
            CreatedAt = now,
        };

    /// <summary>
    /// One answer for every way an activation can fail — wrong code, expired code, unknown
    /// username, disabled worker, suspended company, lost race. Which one it was is precisely what
    /// an attacker wants to learn, and the man on site cannot act on the distinction anyway.
    /// <para>
    /// <b>"Identical" means identical in time as well as in bytes, and the second half is the one
    /// that is easy to lose.</b> Usernames here are guessable — <c>UsernameFormat.Propose</c>
    /// derives one deterministically from a display name, and company and worker names are public
    /// — so a route that answered a known active username a few round trips slower than an unknown
    /// one would hand out the staff list to anyone with a stopwatch. That is why
    /// <see cref="ActivateAsync"/> has no early returns and why the device row is written after
    /// the claim rather than before it. <c>ActivationTimingTests</c> is what keeps it that way;
    /// it measures branch medians against each other, not against a wall-clock number, so it does
    /// not care how slow the machine running it is.
    /// </para>
    /// <para>
    /// Note the asymmetry with <see cref="InvalidLogin"/>, which is not an oversight: login runs
    /// <see cref="PasswordHash.DummyVerify"/>, and ~200–400 ms of uniform PBKDF2 swamps a
    /// one-query difference. Activation has no such cost to hide behind, so the work itself has to
    /// be levelled.
    /// </para>
    /// </summary>
    private static IResult InvalidActivation() => TypedResults.Problem(
        title: "Unauthorized",
        detail: "That username and code do not match a pending activation.",
        statusCode: StatusCodes.Status401Unauthorized);

    private static IResult InvalidLogin() => TypedResults.Problem(
        title: "Unauthorized",
        detail: "Email or password is not correct.",
        statusCode: StatusCodes.Status401Unauthorized);

    private static IResult InvalidToken() => TypedResults.Problem(
        title: "Unauthorized",
        detail: "That link is not valid any more. Ask for a new one.",
        statusCode: StatusCodes.Status401Unauthorized);
}
