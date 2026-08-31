using System.Security.Cryptography;
using System.Text;

namespace Teren.Core.Identity;

/// <summary>
/// The worker's activation code: 8 characters of Crockford base32, shown as <c>XKD4-7HMP</c> (§5).
/// <para>
/// <b>Crockford rather than an alphabet invented this afternoon.</b> Its alphabet already excludes
/// <c>I</c>, <c>L</c>, <c>O</c> and <c>U</c>, so ambiguity is solved by a published convention;
/// and its <em>decode-time folding</em> (<c>O</c>→<c>0</c>, <c>I</c>/<c>L</c>→<c>1</c>,
/// <c>U</c>→<c>V</c>, uppercase, strip separators) means a man who writes an "O" still gets in.
/// </para>
/// <para>
/// <b>Both halves must fold identically or a code will work in one place and not the other.</b>
/// The client half arrives at F3. <b>The contract is exactly this, in order</b>, and the table on
/// <c>CyrillicHomoglyph</c> below is part of it:
/// </para>
/// <list type="number">
/// <item>fold the Cyrillic homoglyphs to their Latin twins — <em>first</em>, because the step
/// below would otherwise delete them silently;</item>
/// <item>drop everything that is not an ASCII letter or digit — spaces, dashes, zero-width
/// characters, a stray emoji pasted out of a chat message;</item>
/// <item>uppercase (invariant);</item>
/// <item>map <c>O</c>→<c>0</c>, <c>I</c>→<c>1</c>, <c>L</c>→<c>1</c>, <c>U</c>→<c>V</c>;</item>
/// <item>accept only if what is left is exactly 8 characters of the alphabet below.</item>
/// </list>
/// <para>
/// 40 bits, single use, 7-day TTL, one live code per worker (<c>ux_activation_code_live</c>),
/// behind an IP rate limiter. The code alone never authenticates anything — activation takes a
/// username as well.
/// </para>
/// </summary>
public static class ActivationCodeFormat
{
    /// <summary>Crockford's encoding alphabet: no <c>I</c>, no <c>L</c>, no <c>O</c>, no <c>U</c>.</summary>
    public const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /// <summary>8 characters at 5 bits each — 40 bits of entropy.</summary>
    public const int Length = 8;

    /// <summary>Where the display dash goes: <c>XKD4-7HMP</c>.</summary>
    private const int GroupSize = 4;

    /// <summary>
    /// Substrings a generated code must not contain. The admin reads this aloud to a customer, so
    /// the cost of a bad draw is embarrassment in a sales conversation. Deliberately short and
    /// deliberately restricted to sequences the alphabet can actually produce — with no
    /// <c>I</c>, <c>O</c>, <c>U</c> or <c>L</c> available, most candidates cannot be spelled at
    /// all. Serbian first, since that is who reads it.
    /// </summary>
    private static readonly string[] Blocked =
    [
        "JEBE", "JEBA", "PZDA", "KRVA", "GOVN", "SRAN", "PSKA",
        "FUCK", "FCK", "SHT", "CNT", "TWAT", "DCK",
    ];

    /// <summary>
    /// A fresh code in canonical form (unformatted, 8 characters). Redrawn until it carries none
    /// of <see cref="Blocked"/>; the loop is bounded because an unbounded retry on a
    /// misconfigured blocklist would hang a request rather than fail it.
    /// </summary>
    public static string Generate()
    {
        for (var attempt = 0; attempt < 64; attempt++)
        {
            var candidate = Draw();
            if (!IsBlocked(candidate))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException(
            "Could not draw an activation code outside the profanity blocklist in 64 attempts; "
            + "the blocklist is almost certainly wrong.");
    }

    /// <summary>The form a human reads and types: <c>XKD4-7HMP</c>.</summary>
    public static string Format(string code)
    {
        ArgumentNullException.ThrowIfNull(code);

        return code.Length <= GroupSize
            ? code
            : string.Concat(code[..GroupSize], "-", code[GroupSize..]);
    }

    /// <summary>
    /// Crockford decode-time folding. Idempotent, and total: anything at all can be passed in,
    /// including what a phone keyboard puts in the clipboard.
    /// </summary>
    public static string Fold(string? input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var folded = new StringBuilder(input.Length);

        foreach (var character in input)
        {
            // Cyrillic BEFORE the ASCII test, or the test deletes it. That is the whole reason
            // the homoglyph table exists: a foreman on a Cyrillic keyboard who types О in an
            // otherwise Latin code used to lose the character silently, and a code that comes out
            // one character short is simply "a code that does not work".
            var raw = CyrillicHomoglyph(character);

            if (!char.IsAsciiLetterOrDigit(raw))
            {
                // Separators, whitespace, zero-width characters and pasted emoji all land here.
                continue;
            }

            var c = char.ToUpperInvariant(raw);

            folded.Append(c switch
            {
                'O' => '0',
                'I' or 'L' => '1',
                'U' => 'V',
                _ => c,
            });
        }

        return folded.ToString();
    }

    /// <summary>
    /// Folds and validates. <paramref name="code"/> is the canonical 8-character form to hash;
    /// it is never the caller's own string, so a handler cannot accidentally hash what was typed.
    /// </summary>
    public static bool TryParse(string? input, out string code)
    {
        code = Fold(input);

        if (code.Length != Length)
        {
            code = string.Empty;
            return false;
        }

        foreach (var c in code)
        {
            if (!Alphabet.Contains(c, StringComparison.Ordinal))
            {
                // Folding cannot rescue this one: a letter outside the alphabet that is not one of
                // Crockford's four confusables is simply not part of any code.
                code = string.Empty;
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// <b>The Cyrillic homoglyph table, and this comment is the contract.</b> Serbian is written
    /// in both scripts, so a code read off a screen and typed on a Cyrillic keyboard — or pasted
    /// out of a chat message someone retyped — arrives carrying Cyrillic letters that are drawn
    /// exactly like Latin ones. Before this table existed, <see cref="Fold"/> dropped them as "not
    /// ASCII", the code came out short, and the man was told his code was wrong.
    /// <para>
    /// <b>Exactly these ten pairs, upper and lower case</b>, each mapped to the Latin letter it is
    /// drawn as. The client half (F3) must implement this list and no other, or a code will
    /// activate in one place and not in the other:
    /// </para>
    /// <code>
    /// А U+0410 → A      а U+0430 → a
    /// Е U+0415 → E      е U+0435 → e
    /// К U+041A → K      к U+043A → k
    /// М U+041C → M      м U+043C → m
    /// О U+041E → O      о U+043E → o     (Crockford then folds O → 0)
    /// Р U+0420 → P      р U+0440 → p
    /// С U+0421 → C      с U+0441 → c
    /// Т U+0422 → T      т U+0442 → t
    /// У U+0423 → Y      у U+0443 → y
    /// Х U+0425 → X      х U+0445 → x
    /// </code>
    /// <para>
    /// <b>В (U+0412) and Н (U+041D) are deliberately absent</b>, although they are just as
    /// convincing as B and H and both Latin targets are in the alphabet. Widening this table is a
    /// change to a contract shared with the client, and a widening applied on one side only is
    /// precisely the "works here, not there" failure the table exists to prevent — so it is a
    /// decision taken on both halves at once, never a line added on one. Leaving them out fails
    /// safe: an unmapped character is dropped, the length check then rejects the code outright,
    /// and the man is asked to try again rather than quietly activated as somebody else.
    /// </para>
    /// </summary>
    private static char CyrillicHomoglyph(char c) => c switch
    {
        'А' => 'A',
        'Е' => 'E',
        'К' => 'K',
        'М' => 'M',
        'О' => 'O',
        'Р' => 'P',
        'С' => 'C',
        'Т' => 'T',
        'У' => 'Y',
        'Х' => 'X',
        'а' => 'a',
        'е' => 'e',
        'к' => 'k',
        'м' => 'm',
        'о' => 'o',
        'р' => 'p',
        'с' => 'c',
        'т' => 't',
        'у' => 'y',
        'х' => 'x',
        _ => c,
    };

    private static string Draw()
    {
        var chars = new char[Length];

        for (var i = 0; i < Length; i++)
        {
            chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        }

        return new string(chars);
    }

    private static bool IsBlocked(string candidate)
    {
        foreach (var word in Blocked)
        {
            if (candidate.Contains(word, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
