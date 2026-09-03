using System.Text.RegularExpressions;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Finding, and reading, the logging call sites under <c>src/</c>.
///
/// <para>
/// Two guards ask different questions of the same text — <see cref="LogRedactionTests"/> asks
/// whether a call site hands the logger a customer's work, and <see cref="LogTemplateTests"/> asks
/// whether every property name in a template can actually reach the log table. They shared nothing
/// but a copy of these three regexes, which is the shape of duplication that ends with two guards
/// disagreeing about what a log call <em>is</em>.
/// </para>
/// </summary>
internal static partial class LogCallSites
{
    /// <summary>
    /// String literals. Removed before a scan that is about the C# expressions, kept whole when
    /// the scan is about the template itself.
    /// </summary>
    public static readonly Regex StringLiterals = new(
        "\"\"\"[\\s\\S]*?\"\"\"|@\"(?:[^\"]|\"\")*\"|\"(?:\\\\.|[^\"\\\\])*\"",
        RegexOptions.Compiled);

    private static readonly Regex LogCall = new(
        @"\bLog(?:Information|Warning|Error|Debug|Trace|Critical|Verbose|Fatal)\s*\(",
        RegexOptions.Compiled);

    /// <summary>
    /// Every <c>Log*(</c> call in a file, from the method name to its matching close paren.
    /// <para>
    /// Balanced-paren scanning rather than a regex for the whole call: log statements here span
    /// half a dozen lines and contain nested calls and ternaries, and a regex that tried to match
    /// "up to the closing bracket" would stop at the first inner one and read half a call site.
    /// </para>
    /// </summary>
    public static List<string> Statements(string code)
    {
        var statements = new List<string>();

        foreach (Match match in LogCall.Matches(code))
        {
            var index = match.Index + match.Length;
            var depth = 1;

            while (index < code.Length && depth > 0)
            {
                depth += code[index] switch { '(' => 1, ')' => -1, _ => 0 };
                index++;
            }

            statements.Add(code[match.Index..index]);
        }

        return statements;
    }

    /// <summary>
    /// The message template of one statement: the run of adjacent string literals that forms the
    /// first string-valued argument, concatenated. Null when the call passes no literal at all.
    ///
    /// <para>
    /// <b>Why a run and not one literal.</b> Almost every template in this tree is written as
    /// <c>"first half " + "second half"</c> to stay inside the line length, and reading only the
    /// first literal would silently miss every property named in the second — which is precisely
    /// the class of omission the guard over this exists to catch.
    /// </para>
    /// <para>
    /// <b>Where the run starts.</b> At the first <c>"</c> after the opening paren, which skips the
    /// optional leading <c>ex,</c> without having to parse an argument list. That is exact for
    /// every shape in this tree and is kept exact by
    /// <c>LogTemplateTests.Every_log_call_passes_a_literal_template_as_its_message</c>, which fails
    /// on a call whose template is not a literal, and by
    /// <c>No_argument_before_the_template_contains_a_string_literal</c>, which fails if anything
    /// before the template ever grows one of its own.
    /// </para>
    /// </summary>
    public static string? TemplateOf(string statement)
    {
        var start = statement.IndexOf('"', StringComparison.Ordinal);
        if (start < 0)
        {
            return null;
        }

        var template = new System.Text.StringBuilder();
        var index = start;

        while (true)
        {
            var literal = StringLiterals.Match(statement, index);
            if (!literal.Success || literal.Index != index)
            {
                break;
            }

            template.Append(literal.Value);
            index = literal.Index + literal.Length;

            // Only a `+` continues the run. A `,` (the next argument) or a `)` ends it, and so
            // does anything else — a template is never built by a method call here, and a guard
            // that quietly accepted one would be reading arguments as though they were template.
            var next = index;
            while (next < statement.Length && char.IsWhiteSpace(statement[next]))
            {
                next++;
            }

            if (next >= statement.Length || statement[next] != '+')
            {
                break;
            }

            index = next + 1;
            while (index < statement.Length && char.IsWhiteSpace(statement[index]))
            {
                index++;
            }
        }

        return template.Length == 0 ? null : template.ToString();
    }

    /// <summary>
    /// The property names a template captures. <c>{{</c> and <c>}}</c> are escapes and yield
    /// nothing; a positional <c>{0}</c> yields nothing; Serilog's <c>{@X}</c> and <c>{$X}</c>
    /// prefixes and any <c>:format</c> or <c>,alignment</c> suffix are stripped, because none of
    /// them is part of the name the sink's allow-list is checked against.
    /// </summary>
    public static IEnumerable<string> TokensOf(string template)
    {
        // The escapes go first, replaced by something with no braces in it, so the token matcher
        // below can be the simple thing it looks like.
        var text = template.Replace("{{", "", StringComparison.Ordinal)
            .Replace("}}", "", StringComparison.Ordinal);

        foreach (Match match in Token().Matches(text))
        {
            var name = match.Groups[1].Value.TrimStart('@', '$');

            var cut = name.IndexOfAny([':', ',']);
            if (cut >= 0)
            {
                name = name[..cut];
            }

            name = name.Trim();

            if (PropertyName().IsMatch(name))
            {
                yield return name;
            }
        }
    }

    /// <summary>
    /// The keys of a <c>BeginScope(new Dictionary&lt;string, object&gt; { ["X"] = … })</c>.
    /// <para>
    /// A scope is the other way a property reaches the sink, and it does not go through a message
    /// template at all — so a scan that looked only at templates would miss it. Both scopes in this
    /// tree are written in exactly this shape; a scope written any other way is caught by
    /// <c>LogTemplateTests.Every_scope_in_the_tree_is_a_dictionary_literal</c> rather than passed
    /// over.
    /// </para>
    /// </summary>
    public static IEnumerable<string> ScopeKeys(string code)
    {
        foreach (Match scope in ScopeCall().Matches(code))
        {
            foreach (Match key in ScopeKey().Matches(scope.Value))
            {
                yield return key.Groups[1].Value;
            }
        }
    }

    /// <summary>Every <c>BeginScope(</c> in a file, with the argument text that follows it.</summary>
    public static int ScopeCount(string code) => BeginScope().Matches(code).Count;

    [GeneratedRegex(@"\{([^{}]*)\}")]
    private static partial Regex Token();

    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_]*$")]
    private static partial Regex PropertyName();

    [GeneratedRegex(@"\bBeginScope\s*\(")]
    private static partial Regex BeginScope();

    [GeneratedRegex(@"\bBeginScope\s*\(\s*new\s+Dictionary<\s*string\s*,\s*object\s*>[\s\S]*?\n\s*\}\)")]
    private static partial Regex ScopeCall();

    [GeneratedRegex("""\[\s*"([^"]+)"\s*\]\s*=""")]
    private static partial Regex ScopeKey();
}
