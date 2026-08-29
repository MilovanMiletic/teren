using System.Text;
using SttSpike.Decoding;
using SttSpike.Providers;
using SttSpike.Scoring;

namespace SttSpike.Reporting;

public sealed record ScoredRun(SttRunResult Result, MoneyWordScore Score);

/// <summary>
/// Writes the run to a timestamped Markdown file so A3 can paste comparisons into
/// <c>docs/stt-evaluation.md</c> without re-running anything.
/// <para>
/// The output directory is gitignored (<c>docs/stt-output/</c>), because transcripts of real site
/// audio are customer material and must never land in the repository.
/// </para>
/// </summary>
public static class ReportWriter
{
    public static string Write(
        string outputDirectory,
        PreparedAudio audio,
        string locale,
        IReadOnlyList<string> phrases,
        string? truthPath,
        IReadOnlyList<MoneyWord> truth,
        IReadOnlyList<ScoredRun> runs)
    {
        Directory.CreateDirectory(outputDirectory);

        var name = $"{DateTime.Now:yyyyMMdd-HHmmss}-{Path.GetFileNameWithoutExtension(audio.OriginalPath)}.md";
        var path = Path.Combine(outputDirectory, name);
        var markdown = new StringBuilder();

        markdown.AppendLine($"# STT spike — {Path.GetFileName(audio.OriginalPath)}");
        markdown.AppendLine();
        markdown.AppendLine($"Run at {DateTime.Now:yyyy-MM-dd HH:mm:ss}.");
        markdown.AppendLine();
        markdown.AppendLine("| | |");
        markdown.AppendLine("| --- | --- |");
        markdown.AppendLine($"| Audio | `{audio.OriginalPath}` |");
        markdown.AppendLine($"| Container | {audio.Container} ({Format.Bytes(audio.BytesOnDisk)}) |");
        markdown.AppendLine($"| Duration | {(audio.Duration is null ? "unknown" : Format.Duration(audio.Duration.Value))} |");
        markdown.AppendLine($"| Locale | {locale} |");
        markdown.AppendLine($"| PCM for the SDK | {(audio.HasPcm ? audio.PcmSource : "unavailable — " + audio.PcmUnavailableReason)} |");
        markdown.AppendLine($"| Phrase hints | {phrases.Count} |");
        markdown.AppendLine($"| Ground truth | {(truth.Count == 0 ? "none" : $"{truth.Count} terms from `{truthPath}`")} |");
        markdown.AppendLine();

        markdown.AppendLine("## Summary");
        markdown.AppendLine();
        markdown.AppendLine("| Provider | Status | Latency | Money words | Missed |");
        markdown.AppendLine("| --- | --- | --- | --- | --- |");

        foreach (var run in runs)
        {
            var status = run.Result.Status.ToString().ToLowerInvariant();
            var latency = run.Result.Status == SttStatus.Ok ? Format.Latency(run.Result.Latency) : "—";
            var score = run.Result.Status == SttStatus.Ok && run.Score.HasTerms
                ? $"{run.Score.Found}/{run.Score.Total}"
                : "—";
            var misses = run.Result.Status == SttStatus.Ok && run.Score.Misses.Count > 0
                ? string.Join(", ", run.Score.Misses)
                : "—";

            markdown.AppendLine($"| `{run.Result.Provider}` | {status} | {latency} | {score} | {misses} |");
        }

        markdown.AppendLine();
        markdown.AppendLine("## Transcripts");

        foreach (var run in runs)
        {
            markdown.AppendLine();
            markdown.AppendLine($"### {run.Result.Provider}");
            markdown.AppendLine();

            if (run.Result.Status != SttStatus.Ok)
            {
                markdown.AppendLine($"_{run.Result.Status.ToString().ToLowerInvariant()}: {run.Result.Detail}_");
                continue;
            }

            if (!string.IsNullOrWhiteSpace(run.Result.Detail))
            {
                markdown.AppendLine($"_{run.Result.Detail}_");
                markdown.AppendLine();
            }

            markdown.AppendLine(run.Result.Transcript);
            markdown.AppendLine();
            markdown.AppendLine($"**Money words:** {run.Score.Line}");

            if (run.Score.Misses.Count > 0)
            {
                markdown.AppendLine();
                markdown.AppendLine("**Missed:**");
                foreach (var miss in run.Score.Misses)
                {
                    markdown.AppendLine($"- {miss}");
                }
            }
        }

        File.WriteAllText(path, markdown.ToString(), new UTF8Encoding(false));
        return path;
    }
}

public static class Format
{
    public static string Bytes(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:0.#} KB",
        _ => $"{bytes / (1024.0 * 1024.0):0.##} MB",
    };

    public static string Duration(TimeSpan value) => $"{(int)value.TotalMinutes}:{value.Seconds:00}";

    public static string Latency(TimeSpan value) => $"{value.TotalSeconds:0.0} s";
}
