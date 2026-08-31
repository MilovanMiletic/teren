using Teren.Core.Entities;

namespace Teren.Core.Tenancy;

/// <summary>
/// Turns the bearer token a caller presents into the person, the role and the tenant it stands
/// for. Two kinds of credential arrive here and both resolve to one shape: a phone's device token
/// (<c>trn_d_</c>) and an admin's session token (<c>trn_s_</c>).
/// <para>
/// This is the seam that used to be <c>IDeviceAuthenticator</c>. It was renamed at D2 rather than
/// extended, because "device" stopped being the only credential the moment admins could sign in —
/// and an interface whose name says device while it also resolves sessions is the kind of drift
/// that ends with somebody adding a second auth path beside it.
/// </para>
/// </summary>
public interface ICredentialAuthenticator
{
    /// <summary>The principal behind the token, or null when the token is not currently good.
    /// <b>Every failure returns null and every null becomes one byte-identical 401</b> — unknown,
    /// expired, revoked, disabled and suspended are indistinguishable, because "revoked" versus
    /// "unknown" is an oracle.</summary>
    ValueTask<TerenPrincipal?> AuthenticateAsync(string token, CancellationToken ct = default);
}

/// <summary>
/// Who is calling (profile-and-identity §6).
/// <para>
/// <b><see cref="CompanyId"/> is null if and only if the caller is a super admin</b>, which is
/// layer 2 of the four that keep Teren staff away from customer evidence: the filter copies this
/// value into <c>TenantContext</c> unconditionally, never from a route parameter, and the
/// evidence model's query filters are deny-by-default — so for a super admin every one of them
/// matches nothing. A platform route that forgot its role gate returns an empty list rather than
/// a company's diary.
/// </para>
/// <para>
/// <b><see cref="DeviceId"/> is provenance</b> — which phone captured the evidence — and is set
/// only for a worker on a bound phone. It is stamped on entries from here and <em>never</em> from
/// the request body: with real devices, a client-supplied id that is not the caller's is a
/// provenance lie on an evidence row.
/// </para>
/// <para>
/// The role is <see cref="AppUserRole"/>, the same enum the <c>app_user.role</c> column and the
/// <c>ck_app_user_role</c> CHECK are built from, rather than a parallel <c>TerenRole</c>. One
/// definition: a second enum with the same three members is a rename away from a route gate that
/// admits the wrong people while everything still compiles.
/// </para>
/// </summary>
public sealed record TerenPrincipal(
    AppUserRole Role,
    Guid UserId,
    Guid? CompanyId,
    Guid? DeviceId,
    string DisplayName)
{
    /// <summary>The admin session this principal came from, when it came from one. Null for a
    /// phone. <c>POST /api/auth/logout</c> is the only thing that reads it — signing out has to
    /// revoke <em>this</em> session and not the caller's other ones.</summary>
    public Guid? SessionId { get; init; }
}
