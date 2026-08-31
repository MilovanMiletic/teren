using System.Text.RegularExpressions;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// <b>Layer 4</b> of the four that keep a super admin away from customer evidence
/// (profile-and-identity §6): a test that reads every <c>.cs</c> file under <c>src/</c> off disk
/// and asserts <c>IgnoreQueryFilters</c> is called in exactly one of them.
/// <para>
/// Layers 1 to 3 are all structural, and this one exists because a structural guarantee can still
/// be walked around by one line. Tenant scoping is deny-by-default precisely so correctness never
/// depends on a handler remembering a <c>Where</c> clause; a stray <c>IgnoreQueryFilters()</c> in a
/// platform endpoint six months from now would undo that quietly, compile cleanly, and pass every
/// other test in this suite.
/// </para>
/// <para>
/// House precedent for reading source off disk is the PWA's <c>i18n.spec.ts</c>, which already
/// walks every dictionary file rather than trusting an import.
/// </para>
/// </summary>
public sealed class QueryFilterAllowListTests
{
    private const string Method = "IgnoreQueryFilters";

    /// <summary>
    /// The only file allowed to call it. The seeder runs outside any tenant scope by definition —
    /// it is what creates the tenants — and it is the reason the rule is "exactly one" rather than
    /// "none".
    /// </summary>
    private const string AllowedFile = "DemoSeeder.cs";

    [Fact]
    public void IgnoreQueryFilters_appears_only_in_DemoSeeder()
    {
        // THE MUTATION TARGET. Adding .IgnoreQueryFilters() to any query in an endpoint, a job or
        // the authenticator must turn this red.
        var offenders = SourceFiles()
            .Where(file => CallsIgnoreQueryFilters(file))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        offenders.ShouldBe([AllowedFile]);
    }

    [Fact]
    public void The_allow_listed_file_really_does_call_it()
    {
        // Anti-vacuity. Without this, renaming the method — or deleting the seeder — would leave
        // the test above passing over an empty set and the guard would be gone with nothing red.
        var seeder = SourceFiles().Single(f => Path.GetFileName(f) == AllowedFile);

        CallsIgnoreQueryFilters(seeder).ShouldBeTrue();
    }

    [Fact]
    public void The_scan_actually_reads_the_source_tree()
    {
        // A wrong repo root would make every assertion above vacuously true. Pin a floor that a
        // real checkout comfortably exceeds and name a file that must be there.
        var files = SourceFiles();

        files.Count.ShouldBeGreaterThan(50);
        files.Select(Path.GetFileName).ShouldContain("TerenDbContext.cs");
        files.Select(Path.GetFileName).ShouldContain("DbCredentialAuthenticator.cs");
    }

    [Fact]
    public void The_auth_path_does_not_reach_past_the_tenant_filters()
    {
        // Stated separately from the allow-list because it is the property that motivated the
        // second DbContext at all: the credential authenticator has to read device, app_user and
        // company before any tenant is known, and it does that through a model that has no
        // filters rather than by switching the evidence model's off.
        var authenticator = SourceFiles()
            .Single(f => Path.GetFileName(f) == "DbCredentialAuthenticator.cs");

        CallsIgnoreQueryFilters(authenticator).ShouldBeFalse();
    }

    /// <summary>
    /// True when the file <em>calls</em> the method, as opposed to mentioning it. Several files
    /// under <c>src/</c> legitimately name it in prose — some with parentheses — so comment lines
    /// are dropped before the scan (<see cref="SourceTree.CodeOf"/>). Dropping whole comment lines
    /// rather than parsing C# is deliberate: it over-matches in the safe direction, since a call
    /// hidden on the same line as a trailing comment is still seen.
    /// </summary>
    private static bool CallsIgnoreQueryFilters(string path) =>
        Regex.IsMatch(SourceTree.CodeOf(path), $@"\.\s*{Method}\s*\(");

    private static List<string> SourceFiles() => SourceTree.Files();
}
