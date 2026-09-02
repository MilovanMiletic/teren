namespace Teren.Api.Contracts;

// ------------------------------------------------------------------ shared

/// <summary>A company as anything outside the platform surface ever needs it: an id and a name.</summary>
public sealed record CompanyRefResponse(Guid Id, string Name);

/// <summary>
/// What became of the code or link that was just issued.
/// <para>
/// <b>The credential is always in the response body regardless of this value</b> (§9). Email is
/// one delivery channel, never <em>the</em> channel: onboarding must not block on a missing
/// address or on an SMTP relay that does not exist yet.
/// </para>
/// </summary>
public static class EmailDelivery
{
    /// <summary>No relay is configured on this host — which is every host today. Visible failure,
    /// startup warning, never a boot refusal.</summary>
    public const string NotConfigured = "not_configured";

    /// <summary>The person has no address on file. Read the code to him instead.</summary>
    public const string NoAddress = "no_address";

    /// <summary>
    /// A relay exists and this code was not mailed, because the route that produced it never
    /// mails one: an admin reads a code to one man, in one message (§2 decision 13). It replaced
    /// <see cref="NotConfigured"/> on those two routes on 2026-09-02, which had become a plain
    /// untruth on any host with a relay.
    /// </summary>
    public const string NotSent = "not_sent";

    /// <summary>Handed to a background job (D6). Never sent inside the request.</summary>
    public const string Queued = "queued";
}

// ------------------------------------------------------------------ /auth/login

/// <summary>Both admin roles sign in the same way; only the gate and the session length differ.</summary>
public sealed record LoginRequest
{
    public string? Email { get; init; }
    public string? Password { get; init; }
}

public sealed record LoginResponse(
    string SessionToken,
    DateTimeOffset ExpiresAt,
    string Role,
    Guid UserId,
    string DisplayName,
    // Null for a super admin, who has no company by construction.
    CompanyRefResponse? Company);

// ------------------------------------------------------------------ /auth/password

/// <summary>Serves the invite and the reset: one token type, one handler, two purposes.</summary>
public sealed record SetPasswordRequest
{
    public string? Token { get; init; }
    public string? Password { get; init; }
}

/// <summary>
/// The email is echoed so the client can prefill the login form the person is about to see. It is
/// not a leak: the caller just proved he holds a single-use token issued for this account.
/// </summary>
public sealed record SetPasswordResponse(string Email, string Role);

// ------------------------------------------------------------------ /auth/activate

public sealed record ActivateRequest
{
    public string? Username { get; init; }

    /// <summary>Typed by a man with gloves on, folded before it is hashed
    /// (<c>ActivationCodeFormat</c>). Separators, case and Cyrillic homoglyphs are all fine.</summary>
    public string? ActivationCode { get; init; }

    /// <summary>What the admin will recognise this phone by — "Zoranov telefon". Optional: the
    /// worker's own name is a better default than refusing to activate a phone over a label.</summary>
    public string? DeviceName { get; init; }
}

/// <summary>
/// The only time a device token is ever transmitted. It is not retrievable afterwards — the
/// database holds its SHA-256 and nothing else — so a phone that loses it re-activates.
/// </summary>
public sealed record ActivateResponse(
    string DeviceToken,
    Guid DeviceId,
    string DeviceName,
    Guid UserId,
    string Username,
    string DisplayName,
    string Language,
    CompanyRefResponse Company);

public sealed record ActivationCodeRequestBody
{
    public string? Username { get; init; }
}

// ------------------------------------------------------------------ /api/me

/// <summary>
/// The PWA's "is my credential still good" probe, and the only place the app learns who it is
/// signed in as. One shape for all three roles; the fields that do not apply are null.
/// </summary>
public sealed record MeResponse(
    string Role,
    Guid UserId,
    string DisplayName,
    string? Username,
    // His own address. Not a disclosure: this route answers only for the credential presented, so
    // the caller is reading back a value he typed into a login form himself. It is here because a
    // company admin has no directory to look himself up in — /api/workers lists the men who
    // record, and /api/platform/users is Teren staff only — so without it the office surface could
    // show him a name and nothing else.
    string? Email,
    string Language,
    CompanyRefResponse? Company,
    MeDeviceResponse? Device,
    DateTimeOffset CreatedAt,
    // The **previous** sign-in, not this one: /auth/login stamps it while minting the session, so
    // by the time an admin reads his own account it says "a moment ago". The account screen shows
    // it beside the sign-in time the browser itself stored, never instead of it. Null for a worker,
    // who never signs in at all (decision 5).
    DateTimeOffset? LastLoginAt);

/// <summary>The phone this credential is bound to. Null for an admin, who has no device.</summary>
public sealed record MeDeviceResponse(Guid Id, string Name);

// ------------------------------------------------------------------ /api/workers

public sealed record WorkerResponse(
    Guid Id,
    string Username,
    string DisplayName,
    string? Email,
    string Language,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    // Phones that are still allowed to record as this man. One, normally — activating a
    // new phone revokes the old one — and zero until he has activated at all.
    int ActiveDeviceCount,
    DateTimeOffset? LastSeenAt,
    // True when there is a code he could type right now. The admin's cue to read it
    // rather than issue a new one, which would kill the code the man is holding.
    bool HasLiveActivationCode);

public sealed record WorkerListResponse(IReadOnlyList<WorkerResponse> Workers, int Count);

public sealed record CreateWorkerRequest
{
    public string? DisplayName { get; init; }

    /// <summary>Optional. Left out, the server proposes one from the display name
    /// (<c>zoran.jovanovic</c>, then <c>zoran.jovanovic2</c>) so nobody ever fights a "taken"
    /// error.</summary>
    public string? Username { get; init; }

    /// <summary>Optional but the normal case (§2 decision 6): with an address he can ask for his
    /// own replacement code, without one he has to ask his boss.</summary>
    public string? Email { get; init; }

    public string? Language { get; init; }
}

/// <summary>The worker and his first code, in one answer: creating a worker you cannot then
/// activate is not a finished action.</summary>
public sealed record CreateWorkerResponse(
    WorkerResponse Worker, ActivationCodeResponse ActivationCode);

/// <summary>
/// Every field is optional and means "leave this alone" when absent — a PATCH, not a PUT. The
/// username is deliberately not here: it is the durable identity a report is signed with, and
/// changing it under a man who has already recorded evidence is a different, deliberate action.
/// </summary>
public sealed record UpdateWorkerRequest
{
    public string? DisplayName { get; init; }

    /// <summary>An explicit JSON <c>null</c> clears the address; an absent field leaves it.</summary>
    public string? Email { get; init; }

    public string? Language { get; init; }

    /// <summary>"Remove a worker" is this, never a delete: every foreign key into
    /// <c>app_user</c> is RESTRICT, because a man who authored evidence must stay nameable.</summary>
    public bool? Disabled { get; init; }
}

public sealed record ActivationCodeResponse(
    // Display form — XKD4-7HMP. Held in the database only while the code is
    // live, and nulled by consumption, supersession and expiry.
    string Code,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    string EmailDelivery);

/// <summary>
/// One worker's ready-made message, in <em>his</em> language, for the admin to paste into
/// <em>his</em> chat. There is deliberately no bulk equivalent — see <c>InviteStrings</c>.
/// </summary>
public sealed record ShareTextResponse(
    string Text, string Language, ActivationCodeResponse ActivationCode);

// ------------------------------------------------------------------ /api/devices

public sealed record DeviceListItemResponse(
    Guid Id,
    string Name,
    Guid UserId,
    string WorkerDisplayName,
    string WorkerUsername,
    DateTimeOffset CreatedAt,
    // Throttled to five minutes (DbCredentialAuthenticator.LastSeenThrottle), so
    // this is "within the last few minutes", not a per-request stamp.
    DateTimeOffset? LastSeenAt,
    DateTimeOffset? RevokedAt);

public sealed record DeviceListResponse(IReadOnlyList<DeviceListItemResponse> Devices, int Count);
