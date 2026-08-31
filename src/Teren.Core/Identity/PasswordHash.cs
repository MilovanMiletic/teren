using System.Globalization;
using System.Security.Cryptography;

namespace Teren.Core.Identity;

/// <summary>
/// Admin passwords. PBKDF2-HMAC-SHA256, pure BCL, so <c>Teren.Core.csproj</c> keeps its zero
/// package references (§5).
/// <para>
/// Stored <b>versioned</b> as <c>pbkdf2-sha256$600000$&lt;salt&gt;$&lt;hash&gt;</c>, so moving to
/// Argon2id later is "rehash on next successful login" rather than a migration and a forced
/// reset for every customer.
/// </para>
/// <para>
/// 600 000 iterations is OWASP's 2023 figure for this algorithm — roughly 150–400 ms per verify.
/// That is fine for an admin login and intolerable on a request path, which is exactly why
/// workers have no password at all and phones present a hashed bearer token instead
/// (<see cref="CredentialTokens"/>). <b>Measure on the real VPS at B3a</b>; whatever ships is
/// pinned by a test, so a change here is a decision rather than a drift.
/// </para>
/// </summary>
public static class PasswordHash
{
    /// <summary>The only algorithm this version writes. Others may still be read — that is what
    /// makes the stored format versioned rather than merely prefixed.</summary>
    public const string Algorithm = "pbkdf2-sha256";

    public const int Iterations = 600_000;

    private const int SaltBytes = 16;
    private const int HashBytes = 32;
    private const char FieldSeparator = '$';

    /// <summary>
    /// A stand-in hash of a value nobody knows, used to answer an unknown account in the same
    /// wall-clock time as a wrong password. Computed once, lazily: the cost of building it is the
    /// cost of one verify, and paying it on every miss would defeat the purpose.
    /// </summary>
    private static readonly Lazy<string> DummyStored =
        new(() => Hash(Convert.ToHexString(RandomNumberGenerator.GetBytes(32))));

    /// <summary>Hashes a password into the versioned stored form.</summary>
    public static string Hash(string password)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);

        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var derived = Derive(password, salt, Iterations);

        return string.Join(
            FieldSeparator,
            Algorithm,
            Iterations.ToString(CultureInfo.InvariantCulture),
            Convert.ToBase64String(salt),
            Convert.ToBase64String(derived));
    }

    /// <summary>
    /// Verifies a password against a stored value.
    /// <para>
    /// Never throws on the stored value, whatever is in it. A malformed, truncated, empty or
    /// unknown-algorithm hash is <c>false</c>, not an exception: this runs on a login path, and a
    /// row written by some future version must not turn into a 500 that tells the caller its
    /// format changed.
    /// </para>
    /// </summary>
    public static bool Verify(string? password, string? stored)
    {
        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(stored))
        {
            return false;
        }

        var parts = stored.Split(FieldSeparator);
        if (parts.Length != 4
            || !string.Equals(parts[0], Algorithm, StringComparison.Ordinal)
            || !int.TryParse(parts[1], CultureInfo.InvariantCulture, out var iterations)
            || iterations <= 0)
        {
            return false;
        }

        byte[] salt;
        byte[] expected;

        try
        {
            salt = Convert.FromBase64String(parts[2]);
            expected = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException)
        {
            return false;
        }

        if (salt.Length == 0 || expected.Length == 0)
        {
            return false;
        }

        var actual = Derive(password, salt, iterations, expected.Length);

        // Fixed-time, as the device-token path already was: a password check must not leak how
        // much of the digest matched through response timing.
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    /// <summary>
    /// Burns the same wall clock a real verify would, for an email that has no account.
    /// <para>
    /// Without it, login is an account-enumeration oracle by stopwatch — "no such account" would
    /// return in microseconds and "wrong password" in a few hundred milliseconds. That would sit
    /// oddly in a codebase that goes to the trouble of making a foreign media id 404 rather than
    /// 409. Callers arrive at D2; it ships here because it belongs with the algorithm.
    /// </para>
    /// </summary>
    public static void DummyVerify(string? password) =>
        _ = Verify(string.IsNullOrEmpty(password) ? "x" : password, DummyStored.Value);

    private static byte[] Derive(string password, byte[] salt, int iterations, int length = HashBytes) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, length);
}
