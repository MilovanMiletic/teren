using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Seeding;

namespace Teren.Infrastructure.Tenancy;

/// <summary>
/// The M0 authenticator: one static token from configuration, resolving to one company
/// (ARCHITECTURE §12 — a deliberate, documented compromise for the distributor demo; no real
/// customer data goes into an environment that runs this).
/// <para>
/// C5 replaces this class with a hashed lookup in the <c>device</c> table. Nothing else moves:
/// the endpoint filter, <see cref="TenantContext"/> and every handler are already written against
/// <see cref="IDeviceAuthenticator"/>.
/// </para>
/// </summary>
public sealed class StaticTokenDeviceAuthenticator : IDeviceAuthenticator
{
    private readonly byte[] _expectedToken;
    private readonly DeviceIdentity _identity;

    public StaticTokenDeviceAuthenticator(IOptions<DeviceAuthOptions> options)
    {
        var value = options.Value;
        _expectedToken = Encoding.UTF8.GetBytes(value.DeviceToken);
        _identity = new DeviceIdentity(
            value.CompanyId ?? DemoSeeder.CompanyId,
            value.DeviceId ?? DemoSeeder.DemoDeviceId);
    }

    public ValueTask<DeviceIdentity?> AuthenticateAsync(
        string token, CancellationToken ct = default)
    {
        // Fixed-time comparison: token checking must not leak the token through response timing.
        var presented = Encoding.UTF8.GetBytes(token);
        var matches = CryptographicOperations.FixedTimeEquals(presented, _expectedToken);

        return ValueTask.FromResult(matches ? _identity : null);
    }
}
