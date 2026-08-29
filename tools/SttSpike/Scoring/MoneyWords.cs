using System.Text;
using System.Text.RegularExpressions;

namespace SttSpike.Scoring;

/// <summary>
/// One term that has to survive transcription, plus the spellings that count as getting it right.
/// </summary>
/// <param name="Label">Exactly as the founder typed it — this is what a miss is reported as.</param>
/// <param name="Alternatives">
/// Accepted spellings, including <paramref name="Label"/>. Alternatives exist because a correct
/// transcript may legitimately word a quantity differently ("40 m" vs "četrdeset metara"), and
/// counting that as a miss would slander the provider.
/// </param>
public sealed record MoneyWord(string Label, IReadOnlyList<string> Alternatives);

public sealed record MoneyWordScore(int Found, int Total, IReadOnlyList<string> Misses)
{
    public bool HasTerms => Total > 0;

    public double Ratio => Total == 0 ? 0 : (double)Found / Total;

    public string Line => Total == 0
        ? "no ground truth for this recording"
        : $"{Found}/{Total} money words ({Ratio:P0})";
}

public static class MoneyWords
{
    /// <summary>Default ground-truth location: sample.ogg -> sample.ogg.truth.txt.</summary>
    public static string DefaultTruthPath(string audioPath) => audioPath + ".truth.txt";

    /// <summary>
    /// Reads the hand-written ground-truth file. Format is deliberately the simplest thing that
    /// can be edited in Notepad on site: one term per line, `#` comments, blank lines ignored,
    /// `|` separating acceptable alternative spellings.
    /// </summary>
    public static IReadOnlyList<MoneyWord> Load(string path)
    {
        var terms = new List<MoneyWord>();

        foreach (var rawLine in File.ReadAllLines(path))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            var alternatives = line
                .Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToArray();

            if (alternatives.Length == 0)
            {
                continue;
            }

            terms.Add(new MoneyWord(alternatives[0], alternatives));
        }

        return terms;
    }

    public static MoneyWordScore Score(string? transcript, IReadOnlyList<MoneyWord> terms)
    {
        if (terms.Count == 0)
        {
            return new MoneyWordScore(0, 0, []);
        }

        var haystack = SerbianText.Haystack(transcript);
        var misses = new List<string>();
        var found = 0;

        foreach (var term in terms)
        {
            if (term.Alternatives.Any(alternative => Contains(haystack, alternative)))
            {
                found++;
            }
            else
            {
                misses.Add(term.Label);
            }
        }

        return new MoneyWordScore(found, terms.Count, misses);
    }

    private static readonly Dictionary<string, Regex> PatternCache = new(StringComparer.Ordinal);

    /// <summary>
    /// Word-start anchored, inflection-tolerant, contiguous matching.
    /// <para>
    /// Serbian inflects almost every noun, so a strict comparison reports misses that are not
    /// misses: a transcript saying "PPR <b>cevi</b> 25" does contain the term "PPR cev 25". Since
    /// the misses are this harness's actual output, a false miss costs founder attention on a
    /// provider that got the word right.
    /// </para>
    /// <para>
    /// The rule, deliberately narrow so it cannot invent a hit: every token must appear in order
    /// and adjacent, each starting on a word boundary. A token of three characters or more may
    /// carry up to three extra letters (cev → cevi, cevima; Nenad → Nenadom). Shorter tokens —
    /// units and numbers like "m" or "25" — must match exactly, because letting those grow is
    /// how "40 m" would falsely match "40 montaža". The final token is left unanchored at its
    /// end, so "PPR cev 25" still matches "PPR cev 25mm".
    /// </para>
    /// <para>
    /// Anything this rule cannot reach is handled explicitly by the <c>|</c> alternatives in the
    /// ground-truth file.
    /// </para>
    /// </summary>
    private static bool Contains(string haystack, string needle)
    {
        var normalized = SerbianText.Normalize(needle);
        if (normalized.Length == 0)
        {
            return false;
        }

        if (!PatternCache.TryGetValue(normalized, out var pattern))
        {
            pattern = BuildPattern(normalized);
            PatternCache[normalized] = pattern;
        }

        return pattern.IsMatch(haystack);
    }

    private static Regex BuildPattern(string normalized)
    {
        var tokens = normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var builder = new StringBuilder();

        for (var i = 0; i < tokens.Length; i++)
        {
            // Normalization already collapsed everything to single spaces.
            builder.Append(i == 0 ? @"(?<=^|\s)" : @"\s");
            builder.Append(TokenPattern(tokens[i], isFinal: i == tokens.Length - 1));
        }

        return new Regex(builder.ToString(), RegexOptions.CultureInvariant);
    }

    private static string TokenPattern(string token, bool isFinal)
    {
        // A word long enough to be distinctive may also change its final vowel, not just gain a
        // suffix: "tlačna proba" is spoken as "tlačne probe", "štemovanje" as "štemovanja".
        if (token.Length >= 5 && "aeiou".Contains(token[^1], StringComparison.Ordinal))
        {
            return Regex.Escape(token[..^1]) + "[a-z]{0,4}";
        }

        if (token.Length >= 3)
        {
            return Regex.Escape(token) + "[a-z]{0,4}";
        }

        // Units and bare numbers ("m", "25"). These must not be allowed to run on freely, or
        // "40 m" matches "40 montažera" and the provider gets credit it did not earn. A final
        // short token may pick up at most two characters, so "25" still matches "25mm".
        return isFinal
            ? Regex.Escape(token) + "[a-z0-9]{0,2}(?![a-z0-9])"
            : Regex.Escape(token);
    }
}
