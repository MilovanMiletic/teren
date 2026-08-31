using System.Text;
using Teren.Core.Text;

namespace Teren.Core.Identity;

/// <summary>
/// The worker's durable identity (profile-and-identity §2 decision 7): what he types on the
/// activation screen, and the one thing that outlives every phone he ever holds.
/// <para>
/// <b>Globally unique, not company-scoped</b>, because the self-service re-activation flow looks a
/// worker up by username alone and must not have to ask "which company?" — a man standing next to
/// a broken phone types one thing. Namespace contention is handled where it belongs: the invite
/// form <em>proposes</em> a name derived from the display name and the admin may edit it, so
/// nobody ever fights a "taken" error.
/// </para>
/// <para>
/// Normalised on write — lowercase, trimmed — and the database agrees
/// (<c>ck_app_user_username_normalised</c>), so two rows can never differ only in case.
/// </para>
/// </summary>
public static class UsernameFormat
{
    /// <summary>Short enough to type with gloves on, long enough for a real name.</summary>
    public const int MinimumLength = 3;

    public const int MaximumLength = 64;

    /// <summary>What the database stores: lowercase and trimmed, exactly what the CHECK asserts.</summary>
    public static string Normalise(string? input) =>
        (input ?? string.Empty).Trim().ToLowerInvariant();

    /// <summary>
    /// True for a normalised username the product will accept: ASCII lowercase letters and digits,
    /// with <c>.</c>, <c>-</c> and <c>_</c> allowed <em>between</em> them but never at either end
    /// and never doubled. Deliberately narrow — this string is read aloud over a phone, typed on a
    /// keyboard whose layout may be Cyrillic, and appears in a chat message; every character it
    /// admits is one that survives all three.
    /// </summary>
    public static bool IsValid(string? username)
    {
        if (string.IsNullOrEmpty(username)
            || username.Length < MinimumLength
            || username.Length > MaximumLength
            || username != Normalise(username))
        {
            return false;
        }

        var previousWasSeparator = true;   // guards the leading position too

        for (var i = 0; i < username.Length; i++)
        {
            var c = username[i];

            if (char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c))
            {
                previousWasSeparator = false;
                continue;
            }

            if (c is not ('.' or '-' or '_') || previousWasSeparator)
            {
                return false;
            }

            previousWasSeparator = true;
        }

        return !previousWasSeparator;
    }

    /// <summary>
    /// A username proposed from a display name: <c>Zoran Jovanović</c> → <c>zoran.jovanovic</c>.
    /// <para>
    /// Cyrillic is transliterated first (<see cref="SerbianScript"/>, the same conversion the
    /// transcript pipeline uses), then the Serbian Latin diacritics are folded — <c>č ć</c> → c,
    /// <c>š</c> → s, <c>ž</c> → z, <c>đ</c> → dj — because this string has to survive a URL, a
    /// terminal and a phone keyboard. <b>Only the username is folded; the display name keeps its
    /// diacritics</b>, and it is the display name that appears on screen and in a report.
    /// </para>
    /// <para>
    /// Returns an empty string when nothing usable is left (a name written entirely in a script
    /// this does not handle). The caller then asks the admin to type one — a proposal is a
    /// convenience, never a requirement.
    /// </para>
    /// </summary>
    public static string Propose(string? displayName)
    {
        var latin = SerbianScript.ToLatin(displayName ?? string.Empty);
        var builder = new StringBuilder(latin.Length + 4);
        var pendingSeparator = false;

        foreach (var raw in latin)
        {
            var folded = FoldDiacritic(raw);

            if (folded.Length == 0)
            {
                // Whitespace, punctuation, anything else: it becomes a single '.' — but only once
                // something has already been written, so a leading dot is impossible.
                pendingSeparator = builder.Length > 0;
                continue;
            }

            if (pendingSeparator)
            {
                builder.Append('.');
                pendingSeparator = false;
            }

            builder.Append(folded);
        }

        var proposed = builder.ToString();

        return proposed.Length > MaximumLength
            ? proposed[..MaximumLength].TrimEnd('.', '-', '_')
            : proposed;
    }

    /// <summary>
    /// The next free name in a family: <c>zoran.jovanovic</c>, then <c>zoran.jovanovic2</c>, then
    /// <c>zoran.jovanovic3</c>. Digits rather than a random suffix because the admin reads this to
    /// the worker, and because a second Zoran Jovanović in the same firm is the ordinary case this
    /// is for.
    /// </summary>
    public static string NextFree(string proposed, Func<string, bool> isTaken)
    {
        ArgumentNullException.ThrowIfNull(isTaken);

        if (!isTaken(proposed))
        {
            return proposed;
        }

        for (var suffix = 2; suffix < 1000; suffix++)
        {
            var candidate = proposed + suffix.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (candidate.Length <= MaximumLength && !isTaken(candidate))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException(
            $"Could not find a free username near '{proposed}'; the admin has to choose one.");
    }

    /// <summary>
    /// One character of a display name as it appears in a username, or empty when it is not a
    /// letter or a digit at all. <c>đ</c> becomes <c>dj</c>, which is why this returns a string.
    /// </summary>
    private static string FoldDiacritic(char c) => char.ToLowerInvariant(c) switch
    {
        'č' or 'ć' => "c",
        'š' => "s",
        'ž' => "z",
        'đ' => "dj",
        var lower when char.IsAsciiLetterLower(lower) || char.IsAsciiDigit(lower)
            => lower.ToString(),
        _ => string.Empty,
    };
}
