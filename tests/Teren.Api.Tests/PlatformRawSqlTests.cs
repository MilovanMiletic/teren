using System.Text.RegularExpressions;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// The scan ARCHITECTURE §12 has owed since the two-context split, and which fell due the moment
/// the log viewer shipped.
///
/// <para>
/// The identity/evidence barrier is a <b>model</b> barrier, not a connection barrier — the caveat
/// §12 states in as many words. Both contexts share a connection string, so
/// <c>TerenIdentityDbContext</c> cannot reach <c>entry</c> through a navigation, a
/// <c>DbSet&lt;&gt;</c> or a query filter, and can reach it in one line of raw SQL. Every typed
/// route is safe by construction; a string is not a type.
/// </para>
///
/// <para>
/// That was theoretical while the platform surface only listed companies and users. D5 makes it
/// concrete: <see cref="Teren.Infrastructure.Logging.LogRetentionJob"/> genuinely needs raw SQL —
/// a set-based <c>DELETE</c> over a table that is a firehose, where loading rows to delete them
/// would be absurd — so "no raw SQL on this side of the split" is no longer a rule anybody can
/// keep. The rule that replaces it is narrower and still exact: <b>raw SQL here may name
/// <c>app_log</c> and nothing that holds evidence.</b>
/// </para>
///
/// <para>
/// Scoped to the two namespaces that a super admin's request actually executes in, rather than to
/// all of <c>src/</c>: the seeder, the migrations and the immutability trigger all name the
/// evidence tables in SQL for good reasons, and a guard that flagged them would be switched off
/// within a week. House precedent for reading source off disk is
/// <see cref="QueryFilterAllowListTests"/>.
/// </para>
/// </summary>
public sealed class PlatformRawSqlTests
{
    /// <summary>
    /// The directories a platform request runs in: the super admin's own read paths, and the
    /// logging code the viewer reads through.
    /// </summary>
    private static readonly string[] PlatformDirectories =
    [
        Path.Combine("Teren.Api", "Platform"),
        Path.Combine("Teren.Api", "Endpoints"),
        Path.Combine("Teren.Infrastructure", "Logging"),
    ];

    /// <summary>
    /// The tables that hold a customer's work. Deliberately the same vocabulary
    /// <c>PlatformPrivacyTests</c> polices on DTO names and <c>LogRedactionTests</c> polices on log
    /// call sites: three guards enforcing one boundary must not disagree about what evidence is.
    /// </summary>
    private static readonly string[] EvidenceTables = ["entry", "media", "report"];

    /// <summary>Anything that hands a string to the database.</summary>
    private static readonly Regex RawSqlCall = new(
        @"\.\s*(FromSqlRaw|FromSqlInterpolated|ExecuteSqlRaw|ExecuteSqlRawAsync|ExecuteSqlInterpolated|ExecuteSqlInterpolatedAsync|SqlQueryRaw|SqlQuery)\s*[(<]",
        RegexOptions.Compiled);

    [Fact]
    public void No_raw_sql_on_the_platform_path_names_an_evidence_table()
    {
        // THE MUTATION TARGET. Add `FromSqlRaw("SELECT ... FROM entry")` to any file under
        // Platform/, Endpoints/ or Logging/ and this must turn red — that one line is the whole
        // of the gap between "Teren staff cannot read a diary" and "Teren staff did not happen to".
        var offenders = new List<string>();

        foreach (var file in PlatformFiles())
        {
            var code = SourceTree.CodeOf(file);
            if (!RawSqlCall.IsMatch(code))
            {
                continue;
            }

            foreach (var table in EvidenceTables)
            {
                // Word-bounded, so `report` does not match `ReportedAt` and `entry` does not match
                // `entry_count`. What is being looked for is a table name inside a SQL string.
                if (Regex.IsMatch(code, $@"\b{table}\b", RegexOptions.IgnoreCase))
                {
                    offenders.Add($"{Path.GetFileName(file)} → {table}");
                }
            }
        }

        offenders.ShouldBeEmpty();
    }

    [Fact]
    public void The_one_raw_statement_that_is_allowed_deletes_app_log_and_only_that()
    {
        // Anti-vacuity, and the reason this file exists rather than a blanket ban: there IS raw SQL
        // on this path. Pin what it is, so that "the scan found nothing" cannot silently come to
        // mean "the scan found nothing because it is looking in the wrong place".
        var withRawSql = PlatformFiles()
            .Where(file => RawSqlCall.IsMatch(SourceTree.CodeOf(file)))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        withRawSql.ShouldBe(["LogRetentionJob.cs"]);
        SourceTree
            .CodeOf(PlatformFiles().Single(f => Path.GetFileName(f) == "LogRetentionJob.cs"))
            .ShouldContain("app_log");
    }

    [Fact]
    public void The_scan_actually_reads_the_platform_source()
    {
        // A wrong root, a renamed folder or a moved endpoint would make the assertions above pass
        // over an empty set.
        var files = PlatformFiles();

        files.Count.ShouldBeGreaterThan(10);
        files.Select(Path.GetFileName).ShouldContain("PlatformEndpoints.cs");
        files.Select(Path.GetFileName).ShouldContain("PlatformLogEndpoints.cs");
        files.Select(Path.GetFileName).ShouldContain("LogRetentionJob.cs");
    }

    private static List<string> PlatformFiles() =>
        SourceTree
            .Files()
            .Where(file =>
                PlatformDirectories.Any(directory =>
                    file.Contains(
                        Path.DirectorySeparatorChar + directory + Path.DirectorySeparatorChar,
                        StringComparison.Ordinal)))
            .ToList();
}
