using System.Diagnostics;

namespace SttSpike.Decoding;

/// <summary>
/// Optional escape hatch for containers with no managed decoder here (m4a/AAC, WebM/Opus, mp3).
/// Used only when ffmpeg is already on PATH — the harness never installs anything and never
/// requires it.
/// </summary>
public static class Ffmpeg
{
    private static string? cachedPath;
    private static bool probed;

    public static bool TryLocate(out string path)
    {
        if (!probed)
        {
            cachedPath = Probe();
            probed = true;
        }

        path = cachedPath ?? string.Empty;
        return cachedPath is not null;
    }

    public static void Convert(string ffmpegPath, string input, string output, int sampleRate)
    {
        var psi = new ProcessStartInfo(ffmpegPath)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "error", "-y",
                     "-i", input,
                     "-vn", "-ac", "1", "-ar", sampleRate.ToString(), "-c:a", "pcm_s16le",
                     output,
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("ffmpeg did not start");

        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"ffmpeg exited {process.ExitCode}: {Truncate(stderr)}");
        }
    }

    private static string? Probe()
    {
        var exe = OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg";
        var pathVariable = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;

        foreach (var directory in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            string candidate;
            try
            {
                candidate = Path.Combine(directory.Trim('"'), exe);
            }
            catch (ArgumentException)
            {
                // A malformed PATH entry is not this tool's problem.
                continue;
            }

            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static string Truncate(string text)
    {
        var trimmed = text.Trim();
        return trimmed.Length <= 300 ? trimmed : trimmed[..300] + "…";
    }
}
