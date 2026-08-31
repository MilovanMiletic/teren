namespace Teren.Core.Identity;

/// <summary>
/// What an admin password has to be. Length and nothing else, deliberately.
/// <para>
/// <b>No composition rules</b> — no "one capital, one digit, one symbol". They are the reason
/// people write <c>Password1!</c> on a sticky note, NIST SP 800-63B has advised against them since
/// 2017, and this product's real defence is elsewhere: PBKDF2 at 600 000 iterations
/// (<see cref="PasswordHash"/>), an IP rate limiter in front of <c>/auth/*</c>, and a login that
/// is not an enumeration oracle. A twelve-character floor buys more than any rule about symbols.
/// </para>
/// <para>
/// <b>No per-account lockout either</b>, and that is a security decision rather than an omission
/// (§7): a lockout hands an attacker a way to lock a paying customer out of his own reports with
/// nothing but his email address.
/// </para>
/// </summary>
public static class PasswordPolicy
{
    /// <summary>Twelve characters. Pinned by a test, so raising or lowering it is a decision.</summary>
    public const int MinimumLength = 12;

    /// <summary>
    /// A ceiling only so that an absurd body cannot turn one login into 600 000 iterations over a
    /// megabyte. Well above any real passphrase.
    /// </summary>
    public const int MaximumLength = 256;

    public static bool IsAcceptable(string? password) =>
        password is not null
        && password.Length >= MinimumLength
        && password.Length <= MaximumLength
        // A password made only of spaces is the one composition rule worth having: it is always a
        // mistake, and it is the one an autofill or a paste actually produces.
        && password.Trim().Length > 0;

    /// <summary>The message a person reads when it is refused. English source string: this is an
    /// API detail line, not screen copy — the client puts its own translated sentence on screen.</summary>
    public const string Requirement =
        "password must be at least 12 characters. There are no rules about capitals, digits or "
        + "symbols — length is what matters.";
}
