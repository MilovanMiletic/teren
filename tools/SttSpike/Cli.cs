namespace SttSpike;

public sealed class CliOptions
{
    public required string AudioPath { get; init; }

    /// <summary>Explicit ground-truth file, or null to look for <c>&lt;audio&gt;.truth.txt</c>.</summary>
    public string? TruthPath { get; init; }

    /// <summary>Explicit phrase-list file, or null to use the built-in demo vocabulary.</summary>
    public string? PhrasesPath { get; init; }

    public bool NoPhrases { get; init; }

    /// <summary>Which demo site's vocabulary to hint with; 0 means all of them.</summary>
    public int Project { get; init; }

    public string? Locale { get; init; }

    public string OutputDirectory { get; init; } = Path.Combine("docs", "stt-output");

    public bool NoWrite { get; init; }

    /// <summary>Provider names to run; empty means all of them.</summary>
    public IReadOnlyList<string> Only { get; init; } = [];
}

public static class Cli
{
    public const string Usage = """
        Teren STT spike (roadmap A1) — transcribe one recording with every configured provider
        and score the result on the words that carry money.

          dotnet run --project tools/SttSpike -- <audio-file> [options]

        Options
          --truth <path>      ground-truth money words
                              (default: <audio-file>.truth.txt when it exists)
          --phrases <path>    phrase-list hints, one per line
                              (default: the demo project vocabulary built into this tool)
          --no-phrases        run without hints
          --project <1|2|3>   hint with one demo site's vocabulary instead of all three
          --locale <code>     override Stt:Azure:Locale (default sr-RS)
          --only <a,b>        run only these providers, by name
          --out <dir>         report directory (default docs/stt-output)
          --no-write          console only, do not write a report file
          -h, --help          this text

        Configuration comes from user-secrets and environment variables. Keys are never taken on
        the command line, so they cannot end up in shell history:

          dotnet user-secrets --project tools/SttSpike set "Stt:Azure:Key" "<key>"
          dotnet user-secrets --project tools/SttSpike set "Stt:Azure:Region" "westeurope"

        Environment-variable form uses double underscores: Stt__Azure__Key.
        """;

    /// <summary>
    /// Returns null when the arguments do not describe a runnable job; <paramref name="error"/>
    /// is empty for a plain <c>--help</c>.
    /// </summary>
    public static CliOptions? Parse(string[] args, out string error)
    {
        error = string.Empty;

        if (args.Length == 0 || args.Contains("-h") || args.Contains("--help"))
        {
            return null;
        }

        string? audio = null;
        string? truth = null;
        string? phrases = null;
        string? locale = null;
        string? outputDirectory = null;
        var noPhrases = false;
        var noWrite = false;
        var project = 0;
        IReadOnlyList<string> only = [];

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];

            switch (arg)
            {
                case "--no-phrases":
                    noPhrases = true;
                    continue;
                case "--no-write":
                    noWrite = true;
                    continue;
            }

            if (arg.StartsWith("--", StringComparison.Ordinal))
            {
                if (i + 1 >= args.Length)
                {
                    error = $"{arg} needs a value.";
                    return null;
                }

                var value = args[++i];
                switch (arg)
                {
                    case "--truth":
                        truth = value;
                        break;
                    case "--phrases":
                        phrases = value;
                        break;
                    case "--locale":
                        locale = value;
                        break;
                    case "--out":
                        outputDirectory = value;
                        break;
                    case "--only":
                        only = value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                        break;
                    case "--project":
                        if (!int.TryParse(value, out project) || project is < 1 or > 3)
                        {
                            error = "--project takes 1, 2 or 3.";
                            return null;
                        }

                        break;
                    default:
                        error = $"Unknown option {arg}.";
                        return null;
                }

                continue;
            }

            if (audio is not null)
            {
                error = "Only one audio file per run.";
                return null;
            }

            audio = arg;
        }

        if (audio is null)
        {
            error = "No audio file given.";
            return null;
        }

        if (!File.Exists(audio))
        {
            error = $"Audio file not found: {Path.GetFullPath(audio)}";
            return null;
        }

        return new CliOptions
        {
            AudioPath = Path.GetFullPath(audio),
            TruthPath = truth,
            PhrasesPath = phrases,
            NoPhrases = noPhrases,
            Project = project,
            Locale = locale,
            OutputDirectory = outputDirectory ?? Path.Combine("docs", "stt-output"),
            NoWrite = noWrite,
            Only = only,
        };
    }
}
