namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Reads every <c>.cs</c> file under <c>src/</c> off disk.
/// <para>
/// Two guards in this suite work this way — the <c>IgnoreQueryFilters</c> allow-list and the 403
/// doctrine — and both exist for the same reason: they catch the one-line change that compiles
/// cleanly, passes every other test, and quietly removes a structural guarantee. House precedent
/// is the PWA's <c>i18n.spec.ts</c>, which already walks every dictionary file rather than
/// trusting an import.
/// </para>
/// </summary>
internal static class SourceTree
{
    public static List<string> Files() =>
        [.. Directory.EnumerateFiles(Root(), "*.cs", SearchOption.AllDirectories)
            // obj/ and bin/ carry generated copies that would double every count.
            .Where(path =>
                !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal)
                && !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal))];

    /// <summary>
    /// The code of a file with whole comment lines removed, so a guard can tell a <em>call</em>
    /// from a <em>mention</em>. Dropping whole comment lines rather than parsing C# is deliberate:
    /// it over-matches in the safe direction — something hidden on the same line as a trailing
    /// comment is still seen.
    /// </summary>
    public static string CodeOf(string path) => string.Join(
        '\n',
        File.ReadAllText(path).Split('\n').Where(line =>
        {
            var trimmed = line.TrimStart();
            return !trimmed.StartsWith("//", StringComparison.Ordinal)
                && !trimmed.StartsWith('*');
        }));

    /// <summary>
    /// <c>src/</c>, found by walking up from <b>this file's own compile-time path</b> and, failing
    /// that, from the test binary.
    /// <para>
    /// <c>[CallerFilePath]</c> first because the binary is not reliably inside the repository: a
    /// build with <c>--artifacts-path</c> (which is how these projects are built while another
    /// process holds a lock on <c>src/Teren.Api/bin</c>) puts it somewhere else entirely, and the
    /// walk from <see cref="AppContext.BaseDirectory"/> then finds no solution file. A guard that
    /// silently cannot find the source tree is worse than no guard, so both routes are tried and
    /// neither failing quietly is possible.
    /// </para>
    /// </summary>
    public static string Root([System.Runtime.CompilerServices.CallerFilePath] string here = "") =>
        SearchUpwards(Path.GetDirectoryName(here))
        ?? SearchUpwards(AppContext.BaseDirectory)
        ?? throw new InvalidOperationException(
            $"Could not find the repository root above '{here}' or "
            + $"'{AppContext.BaseDirectory}'; this test reads the source tree off disk and cannot "
            + "run without it.");

    private static string? SearchUpwards(string? start)
    {
        if (string.IsNullOrEmpty(start) || !Directory.Exists(start))
        {
            return null;
        }

        var directory = new DirectoryInfo(start);

        while (directory is not null)
        {
            if (directory.GetFiles("Teren.slnx").Length > 0
                || directory.GetFiles("Teren.sln").Length > 0)
            {
                var src = Path.Combine(directory.FullName, "src");
                return Directory.Exists(src) ? src : null;
            }

            directory = directory.Parent;
        }

        return null;
    }
}
