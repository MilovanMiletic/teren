namespace Teren.Api.Contracts;

/// <summary>
/// The wire shapes of the super-admin surface (`/api/platform/*`, plan §8).
///
/// <para>
/// <b>What these DTOs deliberately do not contain, and this list is the point of the file.</b>
/// No addresses. No coordinates. No recipient email addresses. No project vocabulary. And no
/// entry, transcript, photograph or report content of any kind. Teren staff can see
/// <em>which companies and sites exist and what is failing</em>; they cannot read a transcript,
/// view a photo, or open a report. That is the whole privacy claim, and it is a sentence the
/// founder may one day have to say to a customer.
/// </para>
///
/// <para>
/// Writing the exclusions down is what makes adding one later a <b>visible decision</b> rather
/// than an afternoon's convenience — and it is backed by more than a comment:
/// <c>PlatformPrivacyTests</c> reflects over every public member of <c>PlatformDirectory</c> and
/// fails if any parameter or return type transitively mentions <c>Entry</c>, <c>Media</c> or
/// <c>Report</c>. <b>That is the test that goes red the day somebody adds <c>entry_count</c> to a
/// company DTO</b>, which is how this boundary would actually be lost — not by a dramatic breach
/// but by one useful-looking field.
/// </para>
///
/// <para>
/// A company's <em>user counts</em> are here and are not a breach of that line: they describe the
/// account, not the work. <c>Project</c> is not represented at all yet — it arrives with D5's
/// health page, where site *names* are admitted by the founder's decision of 2026-08-30 and
/// everything else about a project still is not.
/// </para>
/// </summary>
public sealed record PlatformCompanyResponse(
    Guid Id,
    string Name,
    DateTimeOffset CreatedAt,
    DateTimeOffset? SuspendedAt,
    /// <summary>People, not diaries. How many accounts exist under this company and how many can
    /// actually sign in — the two numbers that answer "is this customer set up or stuck?".</summary>
    int UserCount,
    int ActiveUserCount);

/// <summary>
/// One page, plus the cursor that continues it.
/// <para>
/// <c>NextCursor</c> is null when the server knows this is the last page. It is deliberately
/// <em>not</em> a total count: counting every row to render a page a founder is scrolling is work
/// nobody asked for, and a total that was true when the query ran is a number that goes stale
/// while he reads it.
/// </para>
/// </summary>
public sealed record PlatformCompanyListResponse(
    IReadOnlyList<PlatformCompanyResponse> Companies,
    string? NextCursor);

public sealed record CreateCompanyRequest
{
    public string? Name { get; init; }
}

/// <summary>
/// An account, as Teren staff may see it.
/// <para>
/// The email is here because it is the login key and the only way to identify an admin who cannot
/// get in — the support case this surface exists for. A <em>worker's</em> address is on the same
/// footing: it is how his replacement code reaches him, and a super admin chasing "he never got
/// his code" has to be able to see whether there is an address at all.
/// </para>
/// </summary>
public sealed record PlatformUserResponse(
    Guid Id,
    Guid? CompanyId,
    string? CompanyName,
    /// <summary>`super_admin` | `company_admin` | `worker`.</summary>
    string Role,
    string? Username,
    string DisplayName,
    string? Email,
    string Language,
    DateTimeOffset CreatedAt,
    DateTimeOffset? LastLoginAt,
    DateTimeOffset? DisabledAt,
    /// <summary>
    /// True when this account has never had a password set — the `status=pending` filter's whole
    /// meaning, and the state a founder is looking for when he chases an onboarding that stalled.
    /// **Never the hash, and never a hint about it beyond its existence.**
    /// </summary>
    bool PasswordPending);

public sealed record PlatformUserListResponse(
    IReadOnlyList<PlatformUserResponse> Users,
    string? NextCursor);

/// <summary>
/// The authenticated escape hatch of §9: a set-password link the super admin can read back over
/// the phone.
/// <para>
/// <b>The plaintext token is in this body on purpose, and it is the difference between a customer
/// being unstuck at 9 p.m. and waiting for an SMTP relay nobody has chosen.</b> It is returned
/// here and refused on `/auth/password-reset` because that route is unauthenticated: there, the
/// token would also confirm whether the account exists, and a login surface must not be an
/// account-enumeration oracle. Here the caller is already Teren staff.
/// </para>
/// <para>
/// <b>What this costs, stated plainly, because an earlier draft of this comment got it wrong.</b>
/// It is NOT true that returning the token "reveals nothing to anyone who could not already act".
/// A `reset` — a token for an account that already has a password — is a working impersonation
/// path: `POST /auth/password` is unauthenticated and validates only the token, so whoever holds
/// it can set that admin's password, sign in as him, and read everything his company has. Plan
/// decision 2 says a super admin can never read entries, transcripts, photos or reports; the four
/// layers of §6 make that true of *his own* principal, and this route lets him mint a different
/// one. The capability predates this endpoint — `invite-admin` has done the same from a terminal
/// since D2 — but it is reachable through the product now, and **§13 carries it as a named,
/// founder-owned risk rather than as a comment nobody reads.** The forensic signal is
/// `password_token_issued` with `{"source": "platform", "purpose": "reset"}`: staff minting a
/// link for an account that already had a password is exactly the shape of the dangerous act.
/// </para>
/// </summary>
public sealed record InviteUserResponse(
    /// <summary>`invite` when the account has never had a password, `reset` when it has. Derived
    /// from the row rather than requested, because it is a fact about the account and a flag would
    /// only be a way to record it wrongly.</summary>
    string Purpose,
    string Token,
    /// <summary>The whole link, when `Auth:AppUrl` is configured; null when it is not, in which
    /// case the token above is still perfectly usable and the caller builds the URL himself.</summary>
    string? Url,
    DateTimeOffset ExpiresAt,
    /// <summary>How many previously-live links this one retired. Non-zero means a link that was
    /// already sent has just stopped working — worth saying out loud rather than discovering.</summary>
    int Superseded);

/// <summary>
/// One administrative action, as recorded. The audit trail is the answer to "who took this phone
/// away" and "who was invited and never finished", and it is deliberately thin: ids, a verb, and
/// a JSON detail that follows the same rule as the log stream — ids, counts and outcomes, never
/// transcript, note, structure or recipient content.
/// </summary>
public sealed record PlatformAuditResponse(
    Guid Id,
    Guid ActorUserId,
    string? ActorDisplayName,
    string Action,
    string SubjectType,
    Guid? SubjectId,
    Guid? CompanyId,
    string? Detail,
    DateTimeOffset CreatedAt);

/// <summary>
/// <c>Actions</c>, deliberately not "entries": in this product an <em>entry</em> is a day of a
/// foreman.s work, and naming administrative rows after it would put the one noun this surface
/// may never touch in the middle of its own payload.
/// </summary>
public sealed record PlatformAuditListResponse(
    IReadOnlyList<PlatformAuditResponse> Actions,
    string? NextCursor);

/// <summary>
/// Create an administrator — the one thing D4 could not do, and the reason `/platform` had no
/// "add" button until now.
/// <para>
/// **Workers are deliberately not creatable here.** A foreman belongs to a company and is added by
/// that company's own admin, who knows who is on his sites; Teren staff conjuring foremen into a
/// customer's company would be the platform writing into a tenant's own surface. The role is
/// therefore `super_admin` or `company_admin` and the endpoint refuses anything else.
/// </para>
/// </summary>
public sealed record CreateAdminRequest
{
    /// <summary>`super_admin` or `company_admin`. Never `worker`.</summary>
    public string? Role { get; init; }

    public string? DisplayName { get; init; }

    /// <summary>
    /// Required, and not out of politeness: `ck_app_user_admin_has_email` makes an admin without
    /// one impossible, and an admin who cannot be emailed is an admin who can never be reset.
    /// </summary>
    public string? Email { get; init; }

    /// <summary>
    /// Required for a `company_admin`, and **forbidden for a `super_admin`** —
    /// `ck_app_user_company_scope` makes "a super admin inside a tenant" unstorable, which is
    /// layer 2 of the privacy claim expressed as a constraint rather than a convention.
    /// </summary>
    public Guid? CompanyId { get; init; }

    public string? Language { get; init; }
}

/// <summary>
/// The new administrator, and the link that lets him choose a password.
/// <para>
/// Both in one response on purpose: an account that exists but has no way in is an onboarding the
/// founder has to notice is unfinished. Creating and inviting happen in one transaction for the
/// same reason `CreateWorkerAsync` mints a code in the same transaction as the worker.
/// </para>
/// </summary>
public sealed record PlatformCreateAdminResponse(
    PlatformUserResponse User,
    InviteUserResponse Invite);
