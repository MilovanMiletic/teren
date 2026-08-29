using System.Text;

namespace SttSpike.Scoring;

/// <summary>
/// Folds Serbian text to a plain-ASCII comparison form so scoring is not defeated by things that
/// carry no meaning for us.
/// <para>
/// Three separate hazards, all real on this data:
/// </para>
/// <list type="bullet">
///   <item>Serbian is digraphic. A provider may return Cyrillic ("штемовање") where the ground
///   truth was typed in Latin ("štemovanje"). Without transliteration such a provider scores zero
///   and looks catastrophic when it was actually correct.</item>
///   <item>Diacritics get dropped by providers and by whoever types the ground-truth file.</item>
///   <item>Punctuation and spacing differ freely ("PPR cev 25mm" vs "PPR cev 25 mm.").</item>
/// </list>
/// <para>
/// Latin and Cyrillic must fold to the <em>same</em> target or the fold reintroduces the very
/// mismatch it removes: đ and ђ both become "dj", ć and ћ both become "c", dž and џ both become
/// "dz".
/// </para>
/// </summary>
public static class SerbianText
{
    private static readonly Dictionary<char, string> Map = new()
    {
        // Serbian Latin letters that carry diacritics.
        ['č'] = "c", ['ć'] = "c", ['ž'] = "z", ['š'] = "s", ['đ'] = "dj",

        // Serbian Cyrillic, transliterated to the same targets as their Latin counterparts.
        ['а'] = "a", ['б'] = "b", ['в'] = "v", ['г'] = "g", ['д'] = "d",
        ['ђ'] = "dj", ['е'] = "e", ['ж'] = "z", ['з'] = "z", ['и'] = "i",
        ['ј'] = "j", ['к'] = "k", ['л'] = "l", ['љ'] = "lj", ['м'] = "m",
        ['н'] = "n", ['њ'] = "nj", ['о'] = "o", ['п'] = "p", ['р'] = "r",
        ['с'] = "s", ['т'] = "t", ['ћ'] = "c", ['у'] = "u", ['ф'] = "f",
        ['х'] = "h", ['ц'] = "c", ['ч'] = "c", ['џ'] = "dz", ['ш'] = "s",
    };

    /// <summary>
    /// Lower-cased, transliterated, punctuation-stripped, single-spaced. The result is padded
    /// with a leading and trailing space by <see cref="Haystack"/> so callers can do word-ish
    /// containment tests without a regex.
    /// </summary>
    public static string Normalize(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var lowered = text.ToLowerInvariant();
        var builder = new StringBuilder(lowered.Length + 8);
        var lastWasSpace = true;

        foreach (var ch in lowered)
        {
            if (Map.TryGetValue(ch, out var replacement))
            {
                builder.Append(replacement);
                lastWasSpace = false;
                continue;
            }

            if (char.IsLetterOrDigit(ch))
            {
                builder.Append(ch);
                lastWasSpace = false;
                continue;
            }

            // Everything else — punctuation, quotes, the inch mark in `kuglasti ventil 1"` — is
            // a separator. Collapse runs so spacing differences cannot cause a miss.
            if (!lastWasSpace)
            {
                builder.Append(' ');
                lastWasSpace = true;
            }
        }

        return builder.ToString().Trim();
    }

    /// <summary>Normalized text wrapped in spaces, ready for containment tests.</summary>
    public static string Haystack(string? text) => " " + Normalize(text) + " ";
}
