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
/// What came of asking for an invite: the address it went to, and whether it actually went.
///
/// <para>
/// <b>No token and no URL, by founder decision on 2026-09-01.</b> Until then this carried the
/// plaintext set-password token so staff could read the link down the phone — §9's escape hatch
/// for a product that had no mail relay. The relay exists now, and a credential that passes
/// through a response body, a screen, a clipboard and a chat message is in four more places than
/// it needs to be. The link is minted inside <c>AdminInviteJob</c> and goes to exactly one
/// address.
/// </para>
/// <para>
/// <b><see cref="Emailed"/> false is the honest half of this contract.</b> With no relay
/// configured nothing was sent and the account has no way in; the screen must say so rather than
/// imply an email is in flight. Standing policy is visible failure over silent invention.
/// </para>
/// </summary>
public sealed record InviteSentResponse(
    /// <summary>Where it went. Staff already read this address in the directory, so echoing it is
    /// not a disclosure — and it is the one thing that answers "why has he not had it?".</summary>
    string? Email,
    /// <summary>Queued, not delivered. SMTP returns nothing worth calling a receipt, and this
    /// product never claims a person *received* anything.</summary>
    bool Emailed);

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
/// The new administrator, and how he is being let in.
/// <para>
/// An account that exists with no way in is an onboarding the founder has to notice is
/// unfinished, so the response always says which of the two happened — never neither.
/// </para>
/// <para>
/// <b>The link is not in this body and never will be</b> (founder, 2026-09-01): it is minted
/// inside <c>AdminInviteJob</c> and emailed. <c>Emailed</c> false means no relay was configured,
/// so the account exists with no way in — which the screen has to say out loud.
/// </para>
/// </summary>
public sealed record PlatformCreateAdminResponse(
    PlatformUserResponse User,
    /// <summary>True when an invite mail was queued for his address. Queued, not delivered: SMTP
    /// has nothing worth returning, and this product never claims a person *received* anything.</summary>
    bool Emailed);
