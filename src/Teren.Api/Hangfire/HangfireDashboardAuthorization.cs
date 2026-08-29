using System.Net;
using System.Text;
using Hangfire.Dashboard;

namespace Teren.Api.Hangfire;

/// <summary>
/// The gate in front of <c>/hangfire</c> (ARCHITECTURE §7: "job dashboard, behind auth").
/// <para>
/// The dashboard is a browser surface, so the M0 device bearer token is no use here — nobody
/// sets an Authorization header by typing a URL. It takes HTTP Basic credentials from
/// configuration instead, and when none are configured it serves only loopback requests: on the
/// founder's laptop the dashboard just works, and on a staging box with no credentials set it
/// is unreachable rather than open. There is no third state where it is public.
/// </para>
/// </summary>
public sealed class HangfireDashboardAuthorization(
    string? user, string? password, ILogger logger) : IDashboardAuthorizationFilter
{
    private const string Realm = "Teren jobs";

    public bool Authorize(DashboardContext context)
    {
        var http = context.GetHttpContext();

        if (string.IsNullOrWhiteSpace(user) || string.IsNullOrWhiteSpace(password))
        {
            var remote = http.Connection.RemoteIpAddress;
            var isLocal = remote is not null
                          && (IPAddress.IsLoopback(remote)
                              || remote.Equals(http.Connection.LocalIpAddress));

            if (!isLocal)
            {
                logger.LogWarning(
                    "Refused a non-local request to the Hangfire dashboard: no "
                    + "Hangfire:DashboardUser / Hangfire:DashboardPassword is configured.");
            }

            return isLocal;
        }

        var header = http.Request.Headers.Authorization.ToString();
        if (header.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase)
            && TryReadCredentials(header["Basic ".Length..], out var presentedUser, out var presentedPassword)
            && FixedTimeEquals(presentedUser, user)
            && FixedTimeEquals(presentedPassword, password))
        {
            return true;
        }

        // Prompt rather than 403, so a browser offers the login box.
        http.Response.StatusCode = StatusCodes.Status401Unauthorized;
        http.Response.Headers.WWWAuthenticate = $"Basic realm=\"{Realm}\"";
        return false;
    }

    private static bool TryReadCredentials(string encoded, out string user, out string password)
    {
        user = string.Empty;
        password = string.Empty;

        try
        {
            var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(encoded.Trim()));
            var separator = decoded.IndexOf(':');
            if (separator < 0)
            {
                return false;
            }

            user = decoded[..separator];
            password = decoded[(separator + 1)..];
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    /// <summary>Constant-time comparison: a dashboard password is still a password.</summary>
    private static bool FixedTimeEquals(string presented, string expected) =>
        System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(expected));
}
