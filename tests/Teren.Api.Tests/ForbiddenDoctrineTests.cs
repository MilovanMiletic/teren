using System.Text.RegularExpressions;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// D2 introduced the first 403 into an API whose whole tenancy doctrine is "foreign is
/// indistinguishable from nonexistent". This test is the thing that keeps the two compatible.
/// <para>
/// The doctrine, in the two sentences that decide every case:
/// </para>
/// <blockquote>
/// <b>404 answers questions about existence. 403 answers questions about capability.</b>
/// If the answer depends on <em>which row</em> was named → 404. If it depends only on the caller's
/// <b>role</b> and can be decided <b>without reading any row</b> → 403.
/// </blockquote>
/// <para>
/// The safety property is not the rule; it is <em>where the rule is enforced</em>.
/// <c>RoleFilter</c> is an endpoint filter, so it answers before a handler is entered, before a
/// route parameter is parsed and before a row is read — and therefore cannot leak the existence
/// of anything. That property survives only while 403 is emitted from that one file, which is what
/// these tests read the source tree to prove.
/// </para>
/// <para>
/// House precedent for reading source off disk: <see cref="QueryFilterAllowListTests"/>, and the
/// PWA's <c>i18n.spec.ts</c> before it.
/// </para>
/// </summary>
public sealed class ForbiddenDoctrineTests
{
    private const string AllowedFile = "RoleFilter.cs";

    /// <summary>
    /// Every way of <b>producing</b> a 403 from this API: the framework constant, a status
    /// assigned or passed by name, and the <c>Forbid()</c> result helper.
    /// <para>
    /// <b>Two things are deliberately not matched, and both would make this guard useless rather
    /// than stricter.</b> A bare <c>403</c> anywhere at all: <c>AzureFastTranscriptionProvider</c>
    /// names the number inside an error message a human reads ("the speech service refused the
    /// request (403) — wrong region for this key"). And <c>HttpStatusCode.Forbidden</c>: the same
    /// file switches on it to classify a response Azure sent <em>us</em>. Both are 403s this
    /// product <em>receives</em>; neither is one it emits. A guard that went red on those would be
    /// turned off rather than obeyed.
    /// </para>
    /// </summary>
    private static readonly Regex Forbidden = new(
        @"Status403Forbidden|[Ss]tatus(?:Code)?\s*[:=]\s*403\b|(?:Typed)?Results\.Forbid",
        RegexOptions.Compiled);

    [Fact]
    public void Only_RoleFilter_can_produce_a_403()
    {
        // THE MUTATION TARGET. Returning a 403 from any handler — the obvious way to write "this
        // worker may not touch that" — must turn this red, because a handler has already read an
        // id by the time it can decide, and its 403 would confirm the row exists.
        var offenders = SourceTree.Files()
            .Where(file => Forbidden.IsMatch(SourceTree.CodeOf(file)))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        offenders.ShouldBe([AllowedFile]);
    }

    [Fact]
    public void The_allow_listed_file_really_does_produce_one()
    {
        // Anti-vacuity. Without this, deleting RoleFilter — or renaming the constant — would leave
        // the assertion above passing over an empty set with the guard gone and nothing red.
        var filter = SourceTree.Files().Single(f => Path.GetFileName(f) == AllowedFile);

        Forbidden.IsMatch(SourceTree.CodeOf(filter)).ShouldBeTrue();
    }

    [Fact]
    public void ApiProblems_still_has_no_403_helper()
    {
        // Stated separately from the scan above because this is the file somebody reaches for
        // when they want a 403, and a helper here would make writing one the path of least
        // resistance from every endpoint in the product.
        var apiProblems = SourceTree.Files().Single(f => Path.GetFileName(f) == "ApiProblems.cs");
        var source = File.ReadAllText(apiProblems);

        SourceTree.CodeOf(apiProblems).ShouldNotContain("403");
        source.ShouldNotContain("public static IResult Forbidden");
    }

    [Fact]
    public void The_scan_actually_reads_the_source_tree()
    {
        // A wrong repo root would make every assertion above vacuously true.
        var files = SourceTree.Files();

        files.Count.ShouldBeGreaterThan(50);
        files.Select(Path.GetFileName).ShouldContain("EntryEndpoints.cs");
        files.Select(Path.GetFileName).ShouldContain(AllowedFile);
    }
}
