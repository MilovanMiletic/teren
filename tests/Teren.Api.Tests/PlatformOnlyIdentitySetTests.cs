using System.Text.RegularExpressions;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// The three cross-tenant sets on the filter-less context, and who is allowed to read them.
///
/// <para>
/// <b>Why a scan and not a type rule.</b> <c>TerenIdentityDbContext</c> carries <em>no</em> query
/// filters — <c>IdentityModelTests.The_identity_model_carries_no_query_filters</c> asserts that as
/// a property, because the credential authenticator has to read <c>device</c>, <c>app_user</c> and
/// <c>company</c> before any tenant exists. Every set on it is therefore cross-tenant by
/// construction, which is right for accounts (a super admin's reach over them is the point of the
/// role) and wrong for the three the health page added: <c>PlatformProjects</c>,
/// <c>EntryHealth</c> and <c>ReportHealth</c> describe <em>customers' work</em>, and that context
/// is already injected into eight company-scoped files — <c>WorkerEndpoints</c> alone has nine
/// handlers, plus <c>DeviceEndpoints</c>, <c>MeEndpoints</c>, <c>AuthEndpoints</c>,
/// <c>ActivationCodes</c> and <c>PasswordTokens</c>. ARCHITECTURE §12 names this as residual risk
/// and says no structural guard would notice it.
/// </para>
///
/// <para>
/// <b>The failure it is written against is C10, which is the next increment.</b> A handler on
/// <c>/api/company/sites</c> writing <c>db.PlatformProjects.Where(p =&gt; p.Name.Contains(q))</c>
/// and forgetting <c>p.CompanyId == companyId</c> hands one company admin every customer's site
/// names. Or <c>db.EntryHealth.Where(...)</c>, whose <c>FailureReason</c> is the whole
/// <c>"{code}: {detail}"</c> string with an external provider's own words folded into the detail —
/// cross-tenant, into a DTO no privacy test scans, because
/// <see cref="PlatformPrivacyTests"/> walks the platform surface and a company route is not on it.
/// </para>
///
/// <para>
/// House precedent for reading source off disk is <see cref="QueryFilterAllowListTests"/> and
/// <see cref="PlatformRawSqlTests"/>, and the reasoning is the same in all three: each catches the
/// one line that compiles cleanly, passes every other test, and quietly removes a guarantee.
/// </para>
///
/// <para>
/// <b>What it cannot see, stated rather than discovered.</b> <c>db.Set&lt;Project&gt;()</c>,
/// <c>db.Set&lt;EntryHealthRow&gt;()</c> and a raw SQL string all reach the same rows without
/// naming any property this file matches. The first two are a deliberate act that reads as one;
/// the third is <see cref="PlatformRawSqlTests"/>'s job. This is a tripwire on the accident, not a
/// wall against intent — and the accident is the realistic way a cross-tenant read gets shipped.
/// </para>
/// </summary>
public sealed class PlatformOnlyIdentitySetTests
{
    /// <summary>
    /// The sets on <c>TerenIdentityDbContext</c> that describe a customer's work rather than his
    /// account.
    /// <para>
    /// All three names are <b>unique across <c>src/</c></b>, which is what makes the scan exact.
    /// It was not: the identity context called its site set <c>Projects</c>, the same name the
    /// filtered <c>TerenDbContext</c> uses, so a text scan could not tell a platform read from any
    /// of the four legitimate evidence-side ones — and neither, at a glance, could a reader. The
    /// rename to <c>PlatformProjects</c> (2026-09-04) is half of this guard: the mistake this file
    /// looks for no longer compiles.
    /// </para>
    /// </summary>
    private static readonly string[] PlatformOnlySets =
        ["PlatformProjects", "EntryHealth", "ReportHealth"];

    /// <summary>
    /// The one file allowed to read them: <c>PlatformDirectory.HealthAsync</c>, which reduces all
    /// three to names and counts before anything is serialised.
    /// </summary>
    private const string AllowedFile = "PlatformDirectory.Health.cs";

    [Fact]
    public void The_platform_only_sets_are_read_in_one_file()
    {
        // THE MUTATION TARGET. A `db.PlatformProjects`, `db.EntryHealth` or `db.ReportHealth` in
        // any endpoint, job or command must turn this red — that one line is the difference
        // between "a company admin cannot read another customer's sites" and "no handler has
        // happened to yet".
        var offenders = (
            from file in Scanned()
            where Path.GetFileName(file) != AllowedFile
            from set in PlatformOnlySets
            where Reads(file, set)
            select $"{Path.GetFileName(file)} → {set}").ToList();

        offenders.ShouldBeEmpty(
            "a file other than " + AllowedFile + " reads one of the identity context's "
            + "cross-tenant sets. That context has no query filters, so nothing but the handler's "
            + "own Where clause keeps one customer's sites, entry states and failure reasons away "
            + "from another's administrator. If a company-scoped route genuinely needs sites, it "
            + "reads them from TerenDbContext, where the tenant filter is deny-by-default.\n"
            + string.Join("\n", offenders));
    }

    [Fact]
    public void The_allowed_file_really_does_read_all_three()
    {
        // Anti-vacuity, and the half that matters most here: a renamed set, a moved health page or
        // a regex that matches nothing would leave the assertion above passing over an empty
        // universe for ever. Each name is pinned to the one file that is allowed to use it.
        var health = Scanned().Single(f => Path.GetFileName(f) == AllowedFile);

        foreach (var set in PlatformOnlySets)
        {
            Reads(health, set).ShouldBeTrue(
                $"{AllowedFile} no longer reads {set}; either the health page moved or the set "
                + "was renamed, and this guard is now watching nothing.");
        }
    }

    [Fact]
    public void The_scan_reads_the_company_scoped_files_where_the_risk_actually_lives()
    {
        // A wrong root or a narrowed sweep would make the first assertion vacuous in the one
        // direction that costs something. These are the files that already hold a
        // TerenIdentityDbContext and serve a company admin or a foreman.
        var scanned = Scanned().Select(Path.GetFileName).ToList();

        scanned.Count.ShouldBeGreaterThan(50);

        foreach (var file in new[]
                 {
                     "WorkerEndpoints.cs", "DeviceEndpoints.cs", "MeEndpoints.cs",
                     "AuthEndpoints.cs", "ActivationCodes.cs", "PasswordTokens.cs",
                     "IdentityScope.cs", "PlatformDirectory.cs",
                 })
        {
            scanned.ShouldContain(file);
        }
    }

    [Fact]
    public void The_match_is_a_read_and_not_a_mention()
    {
        // The regex itself, proven both ways — because a pattern this file depends on entirely is
        // worth one test of its own. A prose mention must not fail a build, and a member access
        // must not escape one.
        Match("var rows = db.PlatformProjects.AsNoTracking();", "PlatformProjects").ShouldBeTrue();
        Match("await db . EntryHealth .ToListAsync(ct);", "EntryHealth").ShouldBeTrue();
        Match("identityDb.ReportHealth", "ReportHealth").ShouldBeTrue();

        Match("PlatformProjects is platform-only.", "PlatformProjects").ShouldBeFalse();
        Match("public DbSet<Project> PlatformProjects => Set<Project>();", "PlatformProjects")
            .ShouldBeFalse("the declaration is not a read");
        Match("counts.ReportHealthTotal", "ReportHealth").ShouldBeFalse("word-bounded");
    }

    /// <summary>
    /// True when the file <em>reads</em> the set, as opposed to naming it. A member access
    /// (<c>.Name</c>) with whole comment lines already dropped by
    /// <see cref="SourceTree.CodeOf"/>, and word-bounded so <c>ReportHealthTotal</c> is not
    /// <c>ReportHealth</c>. Dropping comment lines rather than parsing C# over-matches in the safe
    /// direction, which is the same trade the other two source guards make.
    /// </summary>
    private static bool Reads(string path, string set) => Match(SourceTree.CodeOf(path), set);

    private static bool Match(string code, string set) =>
        Regex.IsMatch(code, $@"\.\s*{set}\b");

    /// <summary>
    /// Every <c>.cs</c> file under <c>src/</c> except the generated migrations, which name every
    /// entity in the model by construction and would make the sweep noise. The exclusion is the
    /// same one <see cref="PlatformRawSqlTests"/> makes and for the same reason: a guard that
    /// flags generated code gets switched off within a week.
    /// </summary>
    private static List<string> Scanned() =>
        SourceTree
            .Files()
            .Where(file => !file.Contains(
                Path.DirectorySeparatorChar + "Migrations" + Path.DirectorySeparatorChar,
                StringComparison.Ordinal))
            .ToList();
}
