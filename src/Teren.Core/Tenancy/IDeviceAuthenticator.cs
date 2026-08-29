namespace Teren.Core.Tenancy;

/// <summary>
/// Turns the bearer token a phone presents into the tenant it may act for.
/// <para>
/// M0 (ARCHITECTURE §12) resolves one static token from configuration to the seeded demo
/// company. C5 replaces the <em>implementation</em> with a hashed per-device lookup against the
/// <c>device</c> table — the request pipeline, the filter and everything downstream stay as they
/// are. That is the whole point of this interface existing before there is anything to look up.
/// </para>
/// </summary>
public interface IDeviceAuthenticator
{
    /// <summary>Returns the identity behind the token, or null when it is not a valid token.</summary>
    ValueTask<DeviceIdentity?> AuthenticateAsync(string token, CancellationToken ct = default);
}

/// <summary>
/// Who is calling. <paramref name="DeviceId"/> is provenance — which phone captured the
/// evidence — and is stamped on entries that do not declare one themselves.
/// </summary>
public sealed record DeviceIdentity(Guid CompanyId, Guid? DeviceId);
