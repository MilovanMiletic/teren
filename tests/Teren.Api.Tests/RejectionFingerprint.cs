using Teren.Api.Tests.Infrastructure;
using System.Text.RegularExpressions;

namespace Teren.Api.Tests;

/// <summary>
/// One 401 reduced to everything a caller could actually read off it — status, challenge header
/// and problem body — with the one field that legitimately differs per request removed.
/// <para>
/// <c>trace_id</c> is a correlation id minted per request by ASP.NET Core's problem-details
/// writer. It carries nothing about <em>why</em> the request was refused, so normalising it is not
/// weakening the assertion: what must be identical is every part of the answer that could tell an
/// enumerator which of "unknown token", "revoked device", "disabled user" and "suspended company"
/// he is looking at.
/// </para>
/// </summary>
internal static class RejectionFingerprint
{
    public static async Task<string> OfAsync(HttpResponseMessage response)
    {
        var body = Regex.Replace(
            await response.TextAsync(),
            "\"trace_id\":\"[^\"]*\"",
            "\"trace_id\":\"<per-request>\"");

        return $"{(int)response.StatusCode}|{response.Headers.WwwAuthenticate}|{body}";
    }
}
