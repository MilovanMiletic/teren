namespace Teren.Api.Auth;

/// <summary>
/// The name of the rate-limiting policy applied to <c>/auth/*</c>. A constant rather than a string
/// literal in two files, because <c>RequireRateLimiting</c> with a name no policy was registered
/// under throws at start-up on some paths and, worse, is easy to mistype into a route that then
/// silently has no limiter at all.
/// </summary>
public static class AuthRateLimitPolicy
{
    public const string Name = "auth";
}
