using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Teren.Core.Identity;

/// <summary>
/// Bearer secrets: device tokens, admin session tokens, set-password tokens (§5).
/// <para>
/// <b>Why unsalted SHA-256, and why that is not a mistake.</b> These are 256-bit full-entropy
/// random secrets, not passwords. There is no dictionary to attack, so a slow KDF buys nothing;
/// salting would make the stored value un-indexable and turn every authenticated request into a
/// table scan. This is the standard API-key pattern, and it is what makes
/// <c>ux_device_token_hash</c> a single indexed lookup per request. Passwords are the opposite
/// case and get the opposite treatment — see <see cref="PasswordHash"/>.
/// </para>
/// </summary>
public static class CredentialTokens
{
    /// <summary>A phone's bearer token. No expiry; revocation only.</summary>
    public const string DevicePrefix = "trn_d_";

    /// <summary>An admin's session token.</summary>
    public const string SessionPrefix = "trn_s_";

    /// <summary>An invite or reset link's token.</summary>
    public const string PasswordPrefix = "trn_p_";

    /// <summary>256 bits. Changing this weakens every token in the product at once, so it is a
    /// constant with a name rather than a literal at a call site.</summary>
    public const int SecretBytes = 32;

    /// <summary>
    /// The length of every value this class hashes to, and the width of the <c>char(64)</c>
    /// columns that store them.
    /// <para>
    /// <b>A trap worth knowing before writing raw SQL against those columns.</b> <c>char(n)</c> is
    /// <c>bpchar</c> in Postgres, and <c>bpchar = text</c> is not an indexable equality: comparing
    /// one of these columns against a plain string literal or an untyped parameter can fall back
    /// to a sequential scan and silently lose <c>ux_device_token_hash</c> — the index that IS the
    /// auth path. The shipped path is safe because EF sends the parameter as <c>bpchar</c>;
    /// hand-written SQL must cast (<c>token_hash = $1::char(64)</c>) or it will work correctly
    /// and slowly, which is the hardest kind of regression to notice.
    /// </para>
    /// </summary>
    public const int HashLength = 64;

    /// <summary>
    /// A fresh secret: <paramref name="prefix"/> plus 32 cryptographically random bytes in
    /// base64url. The prefix is there for humans and for log greps — it is not a namespace the
    /// lookup relies on, because each kind of token lives in its own table.
    /// </summary>
    public static string New(string prefix)
    {
        ArgumentException.ThrowIfNullOrEmpty(prefix);

        return prefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(SecretBytes));
    }

    /// <summary>
    /// The stored form: lowercase SHA-256 hex over the token's UTF-8 bytes. Deterministic by
    /// design — that is the whole point, since the lookup is an index seek on the result.
    /// </summary>
    public static string Hash(string token)
    {
        ArgumentNullException.ThrowIfNull(token);

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    }
}
