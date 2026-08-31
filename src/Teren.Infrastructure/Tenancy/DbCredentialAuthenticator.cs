using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Persistence;

namespace Teren.Infrastructure.Tenancy;

/// <summary>
/// Turns a bearer token into a <see cref="TerenPrincipal"/> by looking its hash up in the table
/// that issued it: <c>device</c> for a phone, <c>admin_session</c> for a signed-in admin.
/// <para>
/// <b>One indexed query per request, and no cache — ever.</b> The credential is long-lived and a
/// device token has no expiry at all; the <em>check</em> is what runs every time. That is the
/// entire revocation model (profile-and-identity §2 decision 8, §7): a phone that has been offline
/// for a week presents its token, the row says revoked, and it is refused on first contact, with
/// nothing to push and nothing to expire. Even a 60-second cache would make revocation merely
/// <em>mostly</em> work, which for a security control means not work; <c>DeviceCredentialTests</c>
/// contains a test written specifically to fail if one is ever added, and it deliberately
/// contains no delay.
/// </para>
/// <para>
/// <b>Every failure is byte-identical.</b> An unknown token, a revoked device, an expired or
/// revoked session, a disabled user and a suspended company all return null and become one
/// indistinguishable 401. "Revoked" versus "unknown" is an oracle, and this codebase already goes
/// to the trouble of making a foreign media id 404 rather than 409.
/// </para>
/// <para>
/// <b>Why two lookups rather than a switch on the prefix.</b> The <c>trn_d_</c> / <c>trn_s_</c>
/// prefixes exist for humans and for log greps; branching the auth path on them would make a
/// mistyped or truncated prefix a <em>different</em> failure from a wrong secret, which is a small
/// oracle for no gain. The phone path is tried first because it is the hot one — an admin session
/// costs one extra index seek on a table with a handful of rows, and phones cost nothing extra.
/// </para>
/// <para>
/// It reads through <see cref="TerenIdentityDbContext"/>, which carries no query filters, so the
/// auth path needs no <c>IgnoreQueryFilters()</c> — which is what leaves that call in exactly one
/// file under <c>src/</c>.
/// </para>
/// </summary>
public sealed class DbCredentialAuthenticator(TerenIdentityDbContext db) : ICredentialAuthenticator
{
    /// <summary>
    /// How stale <c>last_seen_at</c> may get before a request refreshes it.
    /// <para>
    /// Throttled rather than written every time, for one reason on each side: the admin's device
    /// list is how a boss recognises which phone he is about to revoke, and "last seen: never"
    /// makes that list useless — but a row update on every authenticated request would put a write
    /// on the hottest path in the system. Outside the window this is a primary-key UPDATE that
    /// matches nothing and writes nothing.
    /// </para>
    /// </summary>
    public static readonly TimeSpan LastSeenThrottle = TimeSpan.FromMinutes(5);

    public async ValueTask<TerenPrincipal?> AuthenticateAsync(
        string token, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(token))
        {
            return null;
        }

        // The presented secret is hashed before it is compared, so the comparison is an index seek
        // on a deterministic value rather than a timing-sensitive string compare. That is the
        // whole reason these tokens are stored as an unsalted digest — see CredentialTokens.
        var tokenHash = CredentialTokens.Hash(token);
        var now = DateTime.UtcNow;

        return await AuthenticateDeviceAsync(tokenHash, now, ct)
            ?? await AuthenticateSessionAsync(tokenHash, now, ct);
    }

    /// <summary>
    /// The phone. One seek on <c>ux_device_token_hash</c>, joined to the two rows that can
    /// withdraw the credential without touching it: the person and the tenant.
    /// </summary>
    private async Task<TerenPrincipal?> AuthenticateDeviceAsync(
        string tokenHash, DateTime now, CancellationToken ct)
    {
        var resolved = await db.Devices
            .AsNoTracking()
            .Where(d => d.TokenHash == tokenHash && d.RevokedAt == null)
            .Join(
                db.Users.Where(u => u.DisabledAt == null),
                device => device.UserId,
                user => user.Id,
                (device, user) => new { device, user })
            .Join(
                db.Companies.Where(c => c.SuspendedAt == null),
                pair => pair.device.CompanyId,
                company => company.Id,
                (pair, _) => new ResolvedDevice(
                    pair.user.Role,
                    pair.user.Id,
                    pair.device.CompanyId,
                    pair.device.Id,
                    pair.user.DisplayName,
                    pair.device.LastSeenAt))
            .FirstOrDefaultAsync(ct);

        if (resolved is null)
        {
            return null;
        }

        if (resolved.LastSeenAt is null || resolved.LastSeenAt < now - LastSeenThrottle)
        {
            await db.Devices
                .Where(d => d.Id == resolved.DeviceId)
                .ExecuteUpdateAsync(u => u.SetProperty(d => d.LastSeenAt, now), ct);
        }

        return new TerenPrincipal(
            resolved.Role,
            resolved.UserId,
            resolved.CompanyId,
            resolved.DeviceId,
            resolved.DisplayName);
    }

    /// <summary>
    /// The admin. Expiry is checked here rather than left to a sweep: a session must stop working
    /// the moment it expires, not the next time something tidies up.
    /// </summary>
    private async Task<TerenPrincipal?> AuthenticateSessionAsync(
        string tokenHash, DateTime now, CancellationToken ct)
    {
        // Query syntax here rather than the method chain the device path uses, and the reason is
        // worth knowing: every predicate has to be applied BEFORE the projection. Filtering on a
        // property of an already-constructed record (`.Select(... new ResolvedSession(...))` then
        // `.Where(r => r.CompanyId == null)`) is not something EF can see through, and it fails at
        // run time on the auth path — that is, on every request an admin makes.
        var resolved = await (
            from session in db.AdminSessions.AsNoTracking()
            join user in db.Users on session.UserId equals user.Id
            where session.TokenHash == tokenHash
                && session.RevokedAt == null
                && session.ExpiresAt > now
                && user.DisabledAt == null
                // A super admin has no company, so there is nothing to suspend; a company admin
                // whose company is suspended is refused exactly as his workers' phones are.
                && (user.CompanyId == null
                    || db.Companies.Any(c => c.Id == user.CompanyId && c.SuspendedAt == null))
            select new ResolvedSession(
                user.Role,
                user.Id,
                user.CompanyId,
                user.DisplayName,
                session.Id,
                session.LastSeenAt))
            .FirstOrDefaultAsync(ct);

        if (resolved is null)
        {
            return null;
        }

        if (resolved.LastSeenAt < now - LastSeenThrottle)
        {
            await db.AdminSessions
                .Where(s => s.Id == resolved.SessionId)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.LastSeenAt, now), ct);
        }

        return new TerenPrincipal(
            resolved.Role,
            resolved.UserId,
            resolved.CompanyId,
            DeviceId: null,
            resolved.DisplayName)
        {
            SessionId = resolved.SessionId,
        };
    }

    private sealed record ResolvedDevice(
        AppUserRole Role,
        Guid UserId,
        Guid CompanyId,
        Guid DeviceId,
        string DisplayName,
        DateTime? LastSeenAt);

    private sealed record ResolvedSession(
        AppUserRole Role,
        Guid UserId,
        Guid? CompanyId,
        string DisplayName,
        Guid SessionId,
        DateTime LastSeenAt);
}
