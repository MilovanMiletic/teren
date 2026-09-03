using Teren.Api.Tests.Infrastructure;
using Teren.Infrastructure.Logging;

namespace Teren.Api.Tests;

/// <summary>
/// <b>Can every property name a log call site writes actually reach the log table?</b>
///
/// <para>
/// The sink's allow-list (<see cref="LogProperties"/>) is enforced in one direction: a name that is
/// not on it is dropped. Nothing looked in the other direction — at the call sites — and asked
/// whether a name they emit is on it. So a property could be added to a template, reviewed,
/// shipped, and be invisible in the viewer for ever, with every test green and the placeholder
/// sitting unrendered in the message where an operator would read it as an omission rather than as
/// a missing registration. <c>{Pending}</c> on the readiness check was exactly that, for a day.
/// </para>
///
/// <para>
/// <b>This is a shape this repository has now been bitten by three times, in three costumes.</b>
/// <c>ee37f04</c> shipped a route rename where every consumer still used the old paths and only
/// the route table had been changed — <c>ng build</c> clean, 538 specs green. F12 declared 33 log
/// action slugs of which 26 had no attribute and no <c>record()</c> call anywhere, so the whole
/// money path would have logged as one generic slug — every spec green, because each asked whether
/// what <em>is</em> wired is wired correctly and none asked whether a declared name is reachable at
/// all. And <c>Serilog.Extensions.Logging</c> rendered Hangfire's pre-rendered state as the literal
/// <c>{State:l}</c>, which the sink dropped, so half the log table was a placeholder on precisely
/// the source "what is failing" is made of. <b>When you add a registry — routes, slugs, property
/// names — the guard that matters is the one that walks it and asks "can this entry ever happen?"</b>
/// </para>
///
/// <para>
/// <b>What this scan deliberately does not cover, and why.</b>
/// </para>
/// <list type="bullet">
/// <item>
/// <b>Serilog output templates.</b> <c>Program.cs</c> configures the console with
/// <c>"[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}"</c>.
/// Those braces name Serilog's own rendering slots, not event properties, and none of them is a
/// name the sink ever sees. They are excluded by construction — the scan reads <c>Log*(...)</c>
/// calls and <c>BeginScope</c>, and an <c>outputTemplate:</c> argument is neither — and named in
/// <see cref="OutputTemplateTokens"/> so that the exclusion is a decision on the record rather than
/// an accident of the regex.
/// </item>
/// <item>
/// <b>Events this codebase does not write.</b> Hangfire's and the framework's lines arrive through
/// <c>Serilog.Extensions.Logging</c> already rendered; they have no template of ours to scan and
/// the sink handles them as third-party text. There is no call site here to check.
/// </item>
/// <item>
/// <b>Names deliberately absent from the allow-list.</b> See <see cref="DroppedOnPurpose"/>. Only
/// <c>From</c> is excluded, and the reason it is excluded is that it is a real, intentional call
/// site whose property the sink is meant to drop. <c>Path</c>, <c>Message</c> and <c>Email</c> were
/// removed from the allow-list in the D5 review and have <b>no</b> live call site, so they are
/// deliberately <em>not</em> excluded: a new use of one of them should be flagged here, which is
/// the direction that matters. That they can never be re-admitted is
/// <c>LogRedactionTests.The_property_allow_list_is_neither_empty_nor_everything</c>'s job.
/// </item>
/// </list>
/// </summary>
public sealed class LogTemplateTests
{
    /// <summary>
    /// Serilog's own rendering slots. Not event properties, never seen by the sink, and unreachable
    /// by this scan — listed so that the exclusion is written down rather than implied.
    /// </summary>
    private static readonly string[] OutputTemplateTokens =
        ["Timestamp", "Level", "Message", "Properties", "NewLine", "Exception"];

    /// <summary>
    /// Names a call site may use even though the sink drops them, because dropping them is the
    /// point.
    ///
    /// <para>
    /// <c>From</c> is the relay's own sender address on the start-up line that makes the port-25
    /// hazard in ARCHITECTURE §10 visible on the console the founder is standing at. It is an
    /// address, so it must never be in the table Teren staff read — and it is not, because it is
    /// not allow-listed. The console keeps it; the database does not. That asymmetry is the design,
    /// so this one name is excluded here rather than reported as an omission.
    /// </para>
    /// </summary>
    private static readonly string[] DroppedOnPurpose = ["From"];

    [Fact]
    public void Every_property_in_a_log_template_can_reach_the_log_table()
    {
        // THE MUTATION TARGET. Adding {Sausage} to any log template under src/ — or renaming an
        // existing property without touching LogProperties — must turn this red.
        var offenders = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var file in SourceTree.Files())
        {
            var code = SourceTree.CodeOf(file);

            foreach (var statement in LogCallSites.Statements(code))
            {
                var template = LogCallSites.TemplateOf(statement);
                if (template is null)
                {
                    continue;
                }

                foreach (var name in LogCallSites.TokensOf(template))
                {
                    seen.Add(name);

                    if (Reachable(name))
                    {
                        continue;
                    }

                    offenders.Add($"{Path.GetFileName(file)}: {{{name}}}");
                }
            }

            // A scope is the other door into the sink and it carries no template at all.
            foreach (var key in LogCallSites.ScopeKeys(code))
            {
                seen.Add(key);

                if (!Reachable(key))
                {
                    offenders.Add($"{Path.GetFileName(file)}: BeginScope key \"{key}\"");
                }
            }
        }

        offenders.Distinct().ShouldBeEmpty(
            "A log call site names a property the sink will drop, so the value never reaches the "
            + "log viewer and the placeholder is stored unrendered — an operator reads it as an "
            + "omission rather than as a missing registration. Add the name to "
            + "LogProperties.Allowed if it is a fact about the machine, or rename it to one that "
            + "already is. If it is customer content, it must not be logged at all.\n"
            + string.Join("\n", offenders.Distinct()));

        // Anti-vacuity. Every part of this guard is a regex over source text and every one of them
        // is a candidate for matching nothing at all.
        seen.Count.ShouldBeGreaterThan(50, "the template scan found almost no properties");
        seen.ShouldContain("EntryId");
        seen.ShouldContain("PendingMigrations", "the readiness check's own property");
        seen.ShouldContain("From", "the excluded name must actually be present, or the exclusion "
            + "is dead weight pretending to document something");
    }

    [Fact]
    public void The_scan_can_actually_fail()
    {
        // Checked-in proof rather than a mutation of the tree, so it is re-run on every build.
        Reachable("Sausage").ShouldBeFalse();
        Unreachable("""logger.LogInformation("Ready in {Sausage}ms", ms);""").ShouldNotBeEmpty();

        // A property on the second half of a concatenated template. This is the one that would
        // silently pass a guard that read only the first literal — and almost every template in
        // this tree is written that way to stay inside the line length.
        Unreachable(
            """
            logger.LogWarning(
                "Entry {EntryId}: something happened "
                + "and it involved {Sausage}.",
                id, sausage);
            """).ShouldNotBeEmpty();

        // Behind an exception argument, which is the other common shape.
        Unreachable("""logger.LogError(ex, "Failed with {Sausage}.", sausage);""")
            .ShouldNotBeEmpty();

        // And the shapes the real tree uses, which must stay green.
        Unreachable("""logger.LogInformation("Entry {EntryId} queued.", id);""").ShouldBeEmpty();
        Unreachable("""logger.LogInformation("via {Host}:{Port}", host, port);""").ShouldBeEmpty();
        Unreachable("""logger.LogWarning("{Count} of {Total}", a, b);""").ShouldBeEmpty();

        // Escapes and positional holes are not property names.
        Unreachable("""logger.LogInformation("a {{Sausage}} b", x);""").ShouldBeEmpty();
        Unreachable("""logger.LogInformation("a {0} b", x);""").ShouldBeEmpty();

        // Serilog's destructuring prefixes and format specifiers are not part of the name.
        Reachable("EntryId").ShouldBeTrue();
        LogCallSites.TokensOf("{@EntryId} {Level:u3} {Count,5}")
            .ShouldBe(["EntryId", "Level", "Count"]);
    }

    [Fact]
    public void Every_log_call_passes_a_literal_template_as_its_message()
    {
        // The scan reads templates as literals. A call whose template is a variable or a constant
        // reference cannot be read, and a guard that quietly skipped such a call would be exactly
        // the "half-right guard" this file exists to avoid — so the answer is to fail rather than
        // to skip. There are none today; the day somebody writes one, this says so and the scan
        // gets taught how to follow it.
        var offenders = new List<string>();

        foreach (var file in SourceTree.Files())
        {
            foreach (var statement in LogCallSites.Statements(SourceTree.CodeOf(file)))
            {
                if (LogCallSites.TemplateOf(statement) is null)
                {
                    offenders.Add($"{Path.GetFileName(file)}: {Compress(statement)}");
                }
            }
        }

        offenders.ShouldBeEmpty(
            "A log call passes no string literal, so its message template cannot be read off the "
            + "source and its properties cannot be checked against the sink's allow-list.\n"
            + string.Join("\n", offenders));
    }

    [Fact]
    public void No_argument_before_the_template_contains_a_string_literal()
    {
        // TemplateOf starts at the first `"` after the opening paren, which is what lets it skip
        // an `ex,` without parsing an argument list. That is exact only while nothing before the
        // template carries a literal of its own — `LogError(new Exception("x"), "{A}", a)` would
        // make it read `"x"` as the template and find no properties, which is a false pass. This
        // is the assumption, stated and checked.
        var offenders = new List<string>();

        foreach (var file in SourceTree.Files())
        {
            foreach (var statement in LogCallSites.Statements(SourceTree.CodeOf(file)))
            {
                var open = statement.IndexOf('(', StringComparison.Ordinal);
                var quote = statement.IndexOf('"', StringComparison.Ordinal);

                if (quote < 0)
                {
                    continue;
                }

                // Anything between the call's own paren and the template must be a bare argument:
                // an identifier, whitespace and commas. A `(` there is a nested call, and a nested
                // call is where a literal could hide.
                var before = statement[(open + 1)..quote];

                if (before.Contains('(', StringComparison.Ordinal))
                {
                    offenders.Add($"{Path.GetFileName(file)}: {Compress(statement)}");
                }
            }
        }

        offenders.ShouldBeEmpty(
            "A log call has a nested call before its message template, so the template scan may "
            + "be reading that call's string literal instead of the template.\n"
            + string.Join("\n", offenders));
    }

    [Fact]
    public void Every_scope_in_the_tree_is_a_dictionary_literal()
    {
        // The scope scan reads `["Key"] =` out of a `new Dictionary<string, object>` initialiser,
        // because that is how both scopes in this tree are written. A scope written any other way
        // — a dictionary built up in a variable, a ValueTuple, a Serilog LogContext push — is a
        // property reaching the sink through a door this guard does not watch. Fail rather than
        // pass over it.
        var found = 0;
        var scopes = 0;

        foreach (var file in SourceTree.Files())
        {
            var code = SourceTree.CodeOf(file);
            scopes += LogCallSites.ScopeCount(code);
            found += LogCallSites.ScopeKeys(code).Count();
        }

        scopes.ShouldBe(2, "the number of BeginScope call sites changed; if a new one is not a "
            + "`new Dictionary<string, object>` literal, LogCallSites.ScopeKeys cannot see its "
            + "keys and the allow-list check above silently skips them");

        found.ShouldBe(4, "two scopes of two keys each (EntryId, CompanyId) — if this drops, the "
            + "scope regex stopped matching and the check above became vacuous");
    }

    [Fact]
    public void The_names_the_readiness_checks_added_can_only_ever_hold_machine_facts()
    {
        // The allow-list works on names, so a name as general as `Path` or `Message` is a hole
        // with a respectable label on it — which is how an anonymous caller's own URL reached this
        // table. `Pending` was the same mistake in a new costume: general enough that its next
        // caller could have put anything under it. These four are the rest of what the readiness
        // work added, and each is pinned to the shape of value it can hold.
        foreach (var name in new[]
                 {
                     "PendingMigrations", "PendingCount", "ServerCount", "MaxAgeSeconds",
                     "DbContextName", "JobServerId",
                 })
        {
            LogProperties.IsAllowed(name).ShouldBeTrue(name);
        }

        // The general word is gone and must stay gone.
        LogProperties.IsAllowed("Pending").ShouldBeFalse(
            "`Pending` is general enough to hold anything its next caller passes; the readiness "
            + "check's property is `PendingMigrations`, which can only be EF migration ids read "
            + "off the shipped assembly");

        // And the values behind those names, read off the source: three ints, one pair of nameof
        // values, one Hangfire-composed id. None of them can carry a caller's text.
        var readiness = SourceTree.Files()
            .Single(f => Path.GetFileName(f) == "ReadinessChecks.cs");

        var code = SourceTree.CodeOf(readiness);

        code.ShouldContain("nameof(TerenDbContext)");
        code.ShouldContain("nameof(TerenIdentityDbContext)");
        code.ShouldContain("pending.Count");
        code.ShouldContain("servers.Count");
        code.ShouldContain("(int)MaxHeartbeatAge.TotalSeconds");
        code.ShouldContain("string.Join(\", \", pending)");
    }

    // ---------------------------------------------------------------------------------- helpers

    private static bool Reachable(string name) =>
        LogProperties.IsColumn(name)
        || LogProperties.IsAllowed(name)
        || DroppedOnPurpose.Contains(name, StringComparer.Ordinal)
        || OutputTemplateTokens.Contains(name, StringComparer.Ordinal);

    private static List<string> Unreachable(string source) =>
        [.. LogCallSites.Statements(source)
            .Select(LogCallSites.TemplateOf)
            .Where(template => template is not null)
            .SelectMany(template => LogCallSites.TokensOf(template!))
            .Where(name => !Reachable(name))];

    private static string Compress(string statement)
    {
        var flat = System.Text.RegularExpressions.Regex
            .Replace(statement, @"\s+", " ").Trim();

        return flat.Length <= 160 ? flat : flat[..160] + "…";
    }
}
