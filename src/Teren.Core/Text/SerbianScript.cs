using System.Text;

namespace Teren.Core.Text;

/// <summary>
/// Serbian Cyrillic → Latin transliteration (ARCHITECTURE §14 decision 8).
/// <para>
/// Azure AI Speech returns <c>sr-RS</c> transcripts in Cyrillic; the product is Latin
/// (ARCHITECTURE §5), so the pipeline converts once at ingestion and stores
/// <c>entry.raw_transcript</c> in Latin. This direction is lossless and deterministic — the
/// reverse is not (<c>nadživeti</c> is ambiguous between н+ж and њ+и... ), which is precisely
/// why the conversion happens here and never the other way round.
/// </para>
/// <para>
/// This is not an alteration of evidence (PROJECT.md principle 2): the audio is the raw
/// evidence and is never touched, and the transcript can be regenerated from it at any time.
/// </para>
/// </summary>
public static class SerbianScript
{
    /// <summary>
    /// Converts Serbian Cyrillic to Serbian Latin. **Idempotent**: text that is already Latin
    /// (or carries no Cyrillic at all) is returned unchanged, so calling this twice is free and
    /// a re-run of the pipeline can never double-convert.
    /// </summary>
    public static string ToLatin(string? text)
    {
        if (string.IsNullOrEmpty(text) || !ContainsCyrillic(text))
        {
            // The overwhelmingly common re-run case, and the guarantee of idempotence: with no
            // Cyrillic there is nothing to map, so the same instance comes back.
            return text ?? string.Empty;
        }

        var builder = new StringBuilder(text.Length + 8);

        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];

            switch (c)
            {
                // The three digraphs are the whole reason this is a function and not a
                // Dictionary<char, char>: one Cyrillic letter becomes two Latin ones, and the
                // casing of the second depends on what follows.
                case 'љ':
                    builder.Append("lj");
                    break;
                case 'њ':
                    builder.Append("nj");
                    break;
                case 'џ':
                    builder.Append("dž");
                    break;
                case 'Љ':
                    builder.Append(NextIsUpperCyrillic(text, i) ? "LJ" : "Lj");
                    break;
                case 'Њ':
                    builder.Append(NextIsUpperCyrillic(text, i) ? "NJ" : "Nj");
                    break;
                case 'Џ':
                    builder.Append(NextIsUpperCyrillic(text, i) ? "DŽ" : "Dž");
                    break;
                default:
                    builder.Append(MapSingle(c));
                    break;
            }
        }

        return builder.ToString();
    }

    /// <summary>True if the text carries at least one Serbian Cyrillic letter.</summary>
    public static bool ContainsCyrillic(string text)
    {
        foreach (var c in text)
        {
            if (IsCyrillicLetter(c))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Whether the next character is an upper-case Cyrillic letter, which is what decides
    /// <c>LJUBAV</c> from <c>Ljubav</c>. A digraph at the end of the text, or before a space or
    /// punctuation, takes the title-case form — the far likelier reading of "Њ." is a word.
    /// </summary>
    private static bool NextIsUpperCyrillic(string text, int index) =>
        index + 1 < text.Length
        && IsCyrillicLetter(text[index + 1])
        && char.IsUpper(text[index + 1]);

    private static bool IsCyrillicLetter(char c) =>
        c is >= 'Ѐ' and <= 'ӿ';

    /// <summary>
    /// One Cyrillic letter to one Latin letter. Anything that is not Serbian Cyrillic — Latin
    /// letters, digits, punctuation, the digits Azure normalises spoken numerals into — passes
    /// through untouched, which is what makes mixed-script text safe.
    /// </summary>
    private static char MapSingle(char c) => c switch
    {
        'а' => 'a', 'б' => 'b', 'в' => 'v', 'г' => 'g', 'д' => 'd', 'ђ' => 'đ',
        'е' => 'e', 'ж' => 'ž', 'з' => 'z', 'и' => 'i', 'ј' => 'j', 'к' => 'k',
        'л' => 'l', 'м' => 'm', 'н' => 'n', 'о' => 'o', 'п' => 'p', 'р' => 'r',
        'с' => 's', 'т' => 't', 'ћ' => 'ć', 'у' => 'u', 'ф' => 'f', 'х' => 'h',
        'ц' => 'c', 'ч' => 'č', 'ш' => 'š',

        'А' => 'A', 'Б' => 'B', 'В' => 'V', 'Г' => 'G', 'Д' => 'D', 'Ђ' => 'Đ',
        'Е' => 'E', 'Ж' => 'Ž', 'З' => 'Z', 'И' => 'I', 'Ј' => 'J', 'К' => 'K',
        'Л' => 'L', 'М' => 'M', 'Н' => 'N', 'О' => 'O', 'П' => 'P', 'Р' => 'R',
        'С' => 'S', 'Т' => 'T', 'Ћ' => 'Ć', 'У' => 'U', 'Ф' => 'F', 'Х' => 'H',
        'Ц' => 'C', 'Ч' => 'Č', 'Ш' => 'Š',

        _ => c,
    };
}
