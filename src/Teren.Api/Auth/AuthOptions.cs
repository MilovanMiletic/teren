using System.ComponentModel.DataAnnotations;
using Teren.Core.Entities;

namespace Teren.Api.Auth;

/// <summary>
/// Everything about credentials that a host may reasonably want to set, bound from the same
/// <c>Auth</c> section as <c>DeviceAuthOptions</c>.
/// <para>
/// Two options classes over one section rather than one class doing both jobs:
/// <c>DeviceAuthOptions</c> is documented as carrying exactly one thing — the demo device's token
/// — and it is deleted outright at D7. This one outlives it.
/// </para>
/// <para>
/// <b>Every value here is a security parameter, so every one is pinned by a test.</b> A lifetime
/// that drifts is not a bug anybody notices until a session that should have ended did not.
/// </para>
/// </summary>
public sealed class AuthOptions : IValidatableObject
{
    public const string SectionName = "Auth";

    /// <summary>
    /// A company admin's session (§5). Thirty days: he signs in on his own laptop to read his
    /// firm's diary, and a weekly re-login would train him to keep the password in a browser.
    /// </summary>
    public TimeSpan SessionLifetime { get; set; } = TimeSpan.FromDays(30);

    /// <summary>
    /// Teren staff (§5). Eight hours, because this session can enumerate every customer — see the
    /// risk register, §13.2. Deliberately about the length of a working day.
    /// </summary>
    public TimeSpan SuperAdminSessionLifetime { get; set; } = TimeSpan.FromHours(8);

    /// <summary>Seven days, single use (§2 decision 3 — the founder's open question 3 is whether
    /// this matches how he actually onboards people).</summary>
    public TimeSpan ActivationCodeLifetime { get; set; } = TimeSpan.FromDays(7);

    /// <summary>An invite or reset link (§5). 48 hours.</summary>
    public TimeSpan PasswordTokenLifetime { get; set; } = TimeSpan.FromHours(48);

    /// <summary>
    /// The origin the PWA is served from. <b>Two callers, and they do not have the same
    /// tolerance for it being empty</b> — which is worth stating here, because this doc comment
    /// described only the forgiving one while the strict one was silently broken.
    ///
    /// <para>
    /// <b>Optional</b> for the worker's activation message (<c>WorkerCodeMailJob</c>,
    /// <c>GET /api/workers/{id}/share-text</c>): the payload is the code, and the message simply
    /// leaves the "download it from" line out rather than printing "download it from (blank)".
    /// </para>
    /// <para>
    /// <b>Required</b> for the admin invite (<c>AdminInviteJob</c>,
    /// <c>PlatformDirectory.Invite</c>): that mail has no content but a set-password link, so with
    /// this empty the invite is refused before a token is minted and <c>emailed</c> is false on
    /// the screen. Deliberately not part of <see cref="Validate"/> — an empty value is legitimate
    /// on a developer's machine and on any host that is not onboarding anybody, and the cost of
    /// getting it wrong is now visible rather than silent. It is
    /// <c>TEREN_APP_ORIGIN</c> in <c>deploy/.env</c>, required by <c>deploy.sh</c> since
    /// 2026-09-04; it was in no deploy artefact before that, which is how the defect shipped.
    /// </para>
    /// </summary>
    public string AppUrl { get; set; } = string.Empty;

    public AuthRateLimitOptions RateLimit { get; set; } = new();

    public TimeSpan SessionLifetimeFor(AppUserRole role) =>
        role == AppUserRole.SuperAdmin ? SuperAdminSessionLifetime : SessionLifetime;

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        foreach (var (name, value, floor, ceiling) in new (string, TimeSpan, TimeSpan, TimeSpan)[]
        {
            (nameof(SessionLifetime), SessionLifetime, TimeSpan.FromMinutes(5), TimeSpan.FromDays(365)),
            (nameof(SuperAdminSessionLifetime), SuperAdminSessionLifetime, TimeSpan.FromMinutes(5), TimeSpan.FromDays(30)),
            (nameof(ActivationCodeLifetime), ActivationCodeLifetime, TimeSpan.FromMinutes(5), TimeSpan.FromDays(90)),
            (nameof(PasswordTokenLifetime), PasswordTokenLifetime, TimeSpan.FromMinutes(5), TimeSpan.FromDays(30)),
        })
        {
            if (value < floor || value > ceiling)
            {
                yield return new ValidationResult(
                    $"Auth:{name} must be between {floor} and {ceiling}; it was {value}.", [name]);
            }
        }

        if (RateLimit.PermitLimit is < 1 or > 1000)
        {
            yield return new ValidationResult(
                "Auth:RateLimit:PermitLimit must be between 1 and 1000. It exists to make "
                + "credential guessing expensive; a limit in the thousands is not a limit.",
                [nameof(RateLimit)]);
        }

        if (RateLimit.Window < TimeSpan.FromSeconds(1) || RateLimit.Window > TimeSpan.FromHours(1))
        {
            yield return new ValidationResult(
                "Auth:RateLimit:Window must be between 1 second and 1 hour.", [nameof(RateLimit)]);
        }
    }
}

/// <summary>
/// The fixed window in front of <c>/auth/*</c> (§7). Ten attempts per five minutes per client IP.
/// <para>
/// <b>By IP and not by account, on purpose.</b> A per-account lockout hands an attacker a way to
/// lock a paying customer out of his own reports with nothing but an email address. Making
/// guessing slow from one place is the half of the problem that can be solved without giving
/// anyone that lever.
/// </para>
/// <para>
/// <c>RemoteIpAddress</c> is trustworthy here because <c>Hosting:BehindProxy</c> already wires
/// <c>UseForwardedHeaders</c> on the hosts that sit behind Caddy, and the API port is not
/// published to the host there — so the only thing that can set <c>X-Forwarded-For</c> is the
/// proxy. On a host where that flag is off, the address is the socket's own.
/// </para>
/// </summary>
public sealed class AuthRateLimitOptions
{
    public int PermitLimit { get; set; } = 10;

    public TimeSpan Window { get; set; } = TimeSpan.FromMinutes(5);
}
