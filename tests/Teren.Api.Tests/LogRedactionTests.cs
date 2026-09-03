using System.Text.RegularExpressions;
using Teren.Api.Tests.Infrastructure;
using Teren.Infrastructure.Logging;

namespace Teren.Api.Tests;

/// <summary>
/// <b>Enforcement 3 of the three that make the log viewer safe to ship</b> (plan §12): a test that
/// reads every <c>.cs</c> file under <c>src/</c> off disk and fails if a log call site interpolates
/// a known evidence-bearing expression.
///
/// <para>
/// The other two enforcements are structural — the sink's property allow-list and its exception
/// scrubbing — and this one exists because both of them work on <em>names</em>. Neither can see
/// inside a string. <c>logger.LogInformation("Entry {EntryId}: {Text}", id, entry.RawTranscript)</c>
/// would sail through both: <c>Text</c> is not allow-listed, so it would be dropped — but rename it
/// to <c>Reason</c>, which is, and a foreman's words are on a screen in Teren's office. This file
/// is what makes that a red test rather than a discovery.
/// </para>
///
/// <para>
/// House precedent for reading source off disk: <see cref="QueryFilterAllowListTests"/> and
/// <c>ForbiddenDoctrineTests</c>, both of which walk <c>src/</c> for the same reason — they catch
/// the one-line change that compiles cleanly and passes every other test.
/// </para>
///
/// <para>
/// <b>The rule is "the expression, unless it is immediately reduced to a count".</b> The existing
/// tree logs <c>entry.RawTranscript.Length</c>, <c>message.Recipients.Count</c> and
/// <c>entry.Structure is null ? "absent" : "present"</c>, and every one of those is exactly the
/// discipline this file is meant to protect: the <em>fact that</em> there is a transcript, never
/// the transcript. Flagging them would have made the guard something people switch off.
/// </para>
/// </summary>
public sealed class LogRedactionTests
{
    /// <summary>
    /// Expressions that carry a customer's work or a person's address.
    ///
    /// <para>
    /// Aligned with the evidence vocabulary <see cref="PlatformPrivacyTests"/> polices on DTO
    /// names, on purpose: two guards enforcing one boundary must not disagree about what counts as
    /// evidence. <c>Notes</c> is on it because <c>notes</c> is the field the verbatim flow puts a
    /// foreman's own words in.
    /// </para>
    /// <para>
    /// <b><c>FromAddress</c> is deliberately absent.</b> It is the product's own relay sender,
    /// configured by the founder, and the one start-up line that names it exists to make the
    /// port-25 hazard in ARCHITECTURE §10 visible. It is not a customer's address and no customer's
    /// address can reach it. It also never reaches <c>app_log</c>: <c>From</c> is not on the sink's
    /// property allow-list, so the line is stored with the placeholder unrendered.
    /// </para>
    /// </summary>
    private static readonly string[] EvidenceExpressions =
    [
        "RawTranscript", "Transcript", "Structure", "Extracted", "Corrected", "Notes",
        "Recipients", "Recipient", "Email", "EmailAddress", "ToAddress",
    ];

    /// <summary>
    /// What makes an evidence expression safe: it is immediately turned into a count, a length or
    /// a null check. Anything else — passing it as an argument, concatenating it, formatting it —
    /// is the thing this file refuses.
    /// </summary>
    private const string SafeReducer =
        @"\s*(\.\s*(Count|Length)\b|\.\s*Count\s*\(\s*\)|is\s+(not\s+)?null|[!=]=\s*null)";

    /// <summary>
    /// String literals, removed before the scan.
    /// <para>
    /// <b>This is what makes the guard precise rather than noisy.</b> A message template contains
    /// <c>{Recipients}</c> and <c>{StructureState}</c> as <em>property names</em>, which are
    /// nothing to do with the values passed beside them; matching over the literal would flag every
    /// well-behaved call site in the product. Stripping the literals leaves only the C#
    /// expressions, which is exactly what the rule is about.
    /// </para>
    /// <para>
    /// Shared with <see cref="LogTemplateTests"/> via <see cref="LogCallSites"/>: two guards over
    /// the same text must not disagree about what a log call is.
    /// </para>
    /// </summary>
    private static readonly Regex StringLiterals = LogCallSites.StringLiterals;

    [Fact]
    public void No_log_call_site_interpolates_evidence()
    {
        // THE MUTATION TARGET. Adding `entry.RawTranscript` (rather than its .Length) to any
        // logger call under src/ must turn this red.
        var offenders = new List<string>();

        foreach (var file in SourceTree.Files())
        {
            foreach (var statement in LogStatements(SourceTree.CodeOf(file)))
            {
                var code = StringLiterals.Replace(statement, "\"\"");

                foreach (var expression in EvidenceExpressions)
                {
                    if (Regex.IsMatch(code, $@"\b{expression}\b(?!{SafeReducer})"))
                    {
                        offenders.Add(
                            $"{Path.GetFileName(file)}: {expression} in "
                            + Compress(code));
                    }
                }
            }
        }

        offenders.ShouldBeEmpty(
            "A log call site passes a customer's work or a person's address to the logger. Those "
            + "lines are now readable by Teren staff on the D5 log viewer, and the product's "
            + "central claim is that they cannot read a transcript, a note or a recipient. Log "
            + "the count, the length or the presence — never the value.\n"
            + string.Join("\n", offenders));
    }

    [Fact]
    public void The_scan_can_actually_fail()
    {
        // Anti-vacuity, and it is not decoration: this guard is a pile of regexes over source
        // text, and every one of them is a candidate for silently matching nothing. Proven
        // against synthetic call sites rather than by mutating the tree, so the proof is checked
        // in and re-run on every build.
        Offends("""logger.LogInformation("Entry {EntryId}: {Reason}", id, entry.RawTranscript);""")
            .ShouldBeTrue();

        Offends("""logger.LogWarning("Sent to {Reason}", report.Recipients);""").ShouldBeTrue();

        Offends("""logger.LogError("Extraction gave {Reason}", entry.Corrected);""").ShouldBeTrue();

        Offends("""logger.LogInformation("Invited {Reason}", user.Email);""").ShouldBeTrue();

        // And the shapes the existing tree really uses, which must stay green.
        Offends("""logger.LogInformation("{Length} chars", entry.RawTranscript.Length);""")
            .ShouldBeFalse();

        Offends("""logger.LogInformation("{RecipientCount}", message.Recipients.Count);""")
            .ShouldBeFalse();

        Offends(
            """
            logger.LogInformation(
                "{StructureState}", entry.Structure is null ? "absent" : "present");
            """).ShouldBeFalse();

        // The property NAME in a template is not the value beside it. If literal-stripping ever
        // broke, this would go red and the real assertion above would drown in false positives.
        Offends("""logger.LogInformation("{Recipients} recipient(s)", recipients.Count);""")
            .ShouldBeFalse();
    }

    [Fact]
    public void The_scan_actually_reads_the_source_tree()
    {
        // A wrong repo root would make the assertion above vacuously true. Same guard, and the
        // same reason, as QueryFilterAllowListTests.
        var files = SourceTree.Files();

        files.Count.ShouldBeGreaterThan(50);
        files.Select(Path.GetFileName).ShouldContain("BoundedRetry.cs");
        files.Select(Path.GetFileName).ShouldContain("EntryProcessor.cs");

        // And it must be finding log calls at all — the whole guard hangs off one regex.
        var sites = files.Sum(f => LogStatements(SourceTree.CodeOf(f)).Count);
        sites.ShouldBeGreaterThan(80, "the log-call scan found almost nothing to inspect");
    }

    /// <summary>
    /// The other half of ARCHITECTURE §12's honesty about the two-context split: it is a
    /// <b>model</b> barrier, not a connection barrier, so raw SQL on the identity context could
    /// still reach <c>entry</c>. §12 says a source scan for that under the platform namespace is
    /// owed "when D4 ships the log viewer". This is it.
    /// </summary>
    [Fact]
    public void The_platform_surface_issues_no_raw_sql()
    {
        var platform = SourceTree.Files()
            .Where(f => f.Contains(
                    $"{Path.DirectorySeparatorChar}Platform{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal)
                || Path.GetFileName(f).StartsWith("Platform", StringComparison.Ordinal))
            .ToList();

        platform.Count.ShouldBeGreaterThan(3, "the scan found no platform files to check");
        platform.Select(Path.GetFileName).ShouldContain("PlatformDirectory.cs");
        platform.Select(Path.GetFileName).ShouldContain("PlatformDirectory.Logs.cs");

        var offenders = platform
            .Where(f => Regex.IsMatch(
                SourceTree.CodeOf(f), @"\.\s*(FromSql\w*|ExecuteSql\w*|SqlQuery\w*)\s*[<(]"))
            .Select(Path.GetFileName)
            .ToList();

        offenders.ShouldBeEmpty(
            "The platform surface issues raw SQL. The two-context split is a model barrier and "
            + "not a connection barrier (ARCHITECTURE §12): both contexts share a connection "
            + "string, so a raw statement here can read `entry` even though the type is not in "
            + "the model. Query through the identity model, or this stops being a guarantee.\n"
            + string.Join("\n", offenders));
    }

    /// <summary>
    /// The allow-list must be a list. If it were ever emptied, or the file replaced by one that
    /// allows everything, the sink would go on "working" and the boundary would be gone with
    /// nothing red.
    /// </summary>
    [Fact]
    public void The_property_allow_list_is_neither_empty_nor_everything()
    {
        LogProperties.AllowedNames.Count.ShouldBeGreaterThan(40);

        // The names that must never be on it, whatever else is.
        foreach (var forbidden in new[]
                 {
                     "RawTranscript", "Transcript", "Structure", "Corrected", "Notes",
                     "Email", "Address", "Recipient", "From",
                 })
        {
            LogProperties.IsAllowed(forbidden).ShouldBeFalse(forbidden);
        }
    }

    // ---------------------------------------------------------------------------------- helpers

    private static bool Offends(string source)
    {
        foreach (var statement in LogStatements(source))
        {
            var code = StringLiterals.Replace(statement, "\"\"");

            if (EvidenceExpressions.Any(e =>
                    Regex.IsMatch(code, $@"\b{e}\b(?!{SafeReducer})")))
            {
                return true;
            }
        }

        return false;
    }

    private static List<string> LogStatements(string code) => LogCallSites.Statements(code);

    private static string Compress(string statement)
    {
        var flat = Regex.Replace(statement, @"\s+", " ").Trim();
        return flat.Length <= 160 ? flat : flat[..160] + "…";
    }
}
