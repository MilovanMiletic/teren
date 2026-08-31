using System.ComponentModel.DataAnnotations;

namespace Teren.Infrastructure.Tenancy;

/// <summary>
/// Bound from the <c>Auth</c> configuration section. It now carries exactly one thing: the
/// <b>demo device's</b> token.
/// <para>
/// This used to be the whole authentication system. It is not any more — <c>DemoSeeder</c>
/// provisions a real <c>device</c> row whose <c>token_hash</c> is <c>SHA-256</c> of this value, so
/// the token compiled into the PWA bundle authenticates as a genuine device bound to a genuine
/// worker, and <c>Auth:DeviceToken</c> stops being a special case in code. The former
/// <c>CompanyId</c> and <c>DeviceId</c> settings are gone: the device row carries both.
/// </para>
/// <para>
/// <b>The token is deliberately no longer required, and that is a security-relevant loosening.</b>
/// A host with no demo device must be able to boot — that is the D7 end state, where
/// <c>environment.deviceToken</c> flips to empty and the demo device is retired. The loosening is
/// bounded rather than open: an <em>empty</em> token means "provision no demo device", while a
/// non-empty one under 16 characters is still refused, so this can never quietly become "any
/// two-character token is fine". An empty value is announced once, loudly, at start-up.
/// </para>
/// </summary>
public sealed class DeviceAuthOptions : IValidatableObject
{
    public const string SectionName = "Auth";

    /// <summary>The minimum length of a token that is configured at all.</summary>
    public const int MinimumTokenLength = 16;

    /// <summary>
    /// The demo device's bearer token, or empty for "no demo device". The dev value in
    /// appsettings.Development.json is a throwaway like the dev Postgres password; staging and
    /// production set <c>Auth__DeviceToken</c> as an environment variable.
    /// </summary>
    public string DeviceToken { get; set; } = string.Empty;

    /// <summary>True when a demo device should be provisioned at seed time.</summary>
    public bool HasDeviceToken => !string.IsNullOrWhiteSpace(DeviceToken);

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (HasDeviceToken && DeviceToken.Length < MinimumTokenLength)
        {
            yield return new ValidationResult(
                $"Auth:DeviceToken must be at least {MinimumTokenLength} characters when it is set "
                + "at all. Leave it empty to run with no demo device.",
                [nameof(DeviceToken)]);
        }
    }
}
