using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Teren.Api.Auth;
using Teren.Api.Contracts;
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

    private static async Task<IResult> ActivateAsync(
        ActivateRequest request,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        ILogger<Device> logger,
        CancellationToken ct)
    {
        // Folded before it is hashed, so a code typed with dashes, in lower case, or with the
        // Cyrillic О a man's keyboard produced still resolves to the same 8 characters.
        if (!ActivationCodeFormat.TryParse(request.ActivationCode, out var code))
        {
            return InvalidActivation();
        }

        var username = UsernameFormat.Normalise(request.Username);
        var codeHash = CredentialTokens.Hash(code);
        var now = DateTime.UtcNow;

        var worker = await db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(
                u => u.Username == username
                    && u.Role == AppUserRole.Worker
                    && u.DisabledAt == null,
                ct);

        if (worker?.CompanyId is not Guid companyId)
        {
            return InvalidActivation();
        }

        var company = await db.Companies
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == companyId && c.SuspendedAt == null, ct);

        if (company is null)
        {
            return InvalidActivation();
        }

        var deviceId = Guid.NewGuid();
        var deviceToken = CredentialTokens.New(CredentialTokens.DevicePrefix);
        var deviceName = DeviceNameOf(request.DeviceName, worker.DisplayName);

        // One transaction, and the order inside it is not free choice: activation_code's
        // consumed_device_id is a foreign key, so the phone has to exist before the code can point
        // at it.
        await using var transaction = await db.Database.BeginTransactionAsync(ct);

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

        // THE CLAIM, and it is the whole reason a code is single-use in practice and not merely
        // in intent. Conditional, so two phones racing one code are settled by the database: the
        // second UPDATE blocks on the row lock, re-evaluates the predicate after the first
        // commits, matches nothing, and rolls its own device row back. Exactly one phone, every
        // time — proven by ActivationRaceTests, not hoped for.
        var claimed = await db.ActivationCodes
            .Where(c => c.UserId == worker.Id
                && c.CodeHash == codeHash
                && c.ConsumedAt == null
                && c.SupersededAt == null
                && c.ExpiresAt > now)
            .ExecuteUpdateAsync(
                u => u
                    .SetProperty(c => c.ConsumedAt, now)
                    .SetProperty(c => c.ConsumedDeviceId, (Guid?)deviceId)
                    // A dead code cannot still be holding plaintext
                    // (ck_activation_code_display_cleared).
                    .SetProperty(c => c.CodeDisplay, (string?)null),
                ct);

        if (claimed == 0)
        {
            // Wrong code, expired code, superseded code, or someone else took it a millisecond
            // ago. All four are one answer: which of them it was is exactly what an attacker
            // would like to know.
            await transaction.RollbackAsync(ct);
            return InvalidActivation();
        }

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
            new CompanyRefResponse(company.Id, company.Name)));
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
    /// <b>Why this is safe to leave unauthenticated even though it kills the live code.</b>
    /// Anyone who knows a username can supersede the code his boss just sent him, which is a
    /// nuisance. It is bounded by the IP rate limiter, and by only ever issuing when the worker
    /// actually has an address: a code nobody can be sent is not worth destroying a usable one
    /// for. The alternative — leaving the old code live — would put two typeable codes on one
    /// worker, which the database refuses outright (<c>ux_activation_code_live</c>).
    /// </para>
    /// </summary>
    private static async Task<IResult> RequestActivationCodeAsync(
        ActivationCodeRequestBody request,
        TerenIdentityDbContext db,
        IOptions<AuthOptions> options,
        ILogger<ActivationCode> logger,
        CancellationToken ct)
    {
        var username = UsernameFormat.Normalise(request.Username);

        var worker = username.Length == 0
            ? null
            : await db.Users.FirstOrDefaultAsync(
                u => u.Username == username
                    && u.Role == AppUserRole.Worker
                    && u.DisabledAt == null,
                ct);

        var eligible = worker?.Email is not null
            && worker.CompanyId is Guid companyId
            && await db.Companies.AnyAsync(
                c => c.Id == companyId && c.SuspendedAt == null, ct);

        if (eligible)
        {
            // The actor is the worker himself, which is exactly what the audit column should say.
            await ActivationCodes.IssueAsync(
                db,
                worker!,
                worker!.Id,
                AdminAuditActions.ActivationCodeSelfRequested,
                options.Value.ActivationCodeLifetime,
                ct);

            // TODO(D6): hand the plaintext to the mail job here. Until IMailSender exists the code
            // is issued and visible to the admin on the worker surface, which is the fallback the
            // whole design keeps deliberately available — but the self-service path is not
            // *self*-service until this line sends something.
            logger.LogInformation(
                "Activation code re-issued on request for user {UserId}; no mail transport yet, "
                + "so it is readable only on the admin surface.", worker.Id);
        }

        // Byte-identical whether or not anything happened above.
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
