using System.Text;
using Microsoft.Extensions.Configuration;
using SttSpike;
using SttSpike.Decoding;
using SttSpike.Providers;
using SttSpike.Reporting;
using SttSpike.Scoring;

// Serbian output on a Windows console is mojibake without this.
try
{
    Console.OutputEncoding = Encoding.UTF8;
}
catch (IOException)
{
    // Redirected output; nothing to set.
}

var cli = Cli.Parse(args, out var argumentError);
if (cli is null)
{
    if (argumentError.Length > 0)
    {
        Console.Error.WriteLine(argumentError);
        Console.Error.WriteLine();
    }

    Console.WriteLine(Cli.Usage);
    return argumentError.Length > 0 ? 2 : 0;
}

// Keys come only from user-secrets and the environment. Deliberately no command-line
// configuration source: a key passed as an argument would land in shell history.
var configuration = new ConfigurationBuilder()
    .AddUserSecrets(typeof(Program).Assembly, optional: true)
    .AddEnvironmentVariables()
    .Build();

var options = SttOptions.Load(configuration);
var locale = string.IsNullOrWhiteSpace(cli.Locale) ? options.Azure.Locale : cli.Locale;

using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cancellation.Cancel();
};

// Decoded PCM is written outside the repository: transcripts and audio of real sites must never
// reach a tracked path.
var workDirectory = Path.Combine(Path.GetTempPath(), "teren-stt-spike");
var audio = AudioPreparer.Prepare(cli.AudioPath, workDirectory);

var phrases = LoadPhrases(cli);
var (truthPath, truth) = LoadTruth(cli);

PrintPreflight(audio, locale, phrases, truthPath, truth, options);

using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };

var providers = new List<ISttProvider>
{
    new AzureFastTranscriptionProvider(options.Azure, http),
    new AzureContinuousProvider(options.Azure, useHints: false),
    new AzureContinuousProvider(options.Azure, useHints: true),
    new OpenAiCompatibleProvider("openai-whisper", options.OpenAi, http, requiresKey: true),
    new ElevenLabsProvider(options.ElevenLabs, http),
    new OpenAiCompatibleProvider("local-whisper", options.LocalWhisper, http, requiresKey: false),
    new GoogleSttProvider(options.GoogleCredentialsPath),
};

if (cli.Only.Count > 0)
{
    providers = providers
        .Where(p => cli.Only.Contains(p.Name, StringComparer.OrdinalIgnoreCase))
        .ToList();

    if (providers.Count == 0)
    {
        Console.Error.WriteLine($"--only matched no provider. Known names: {string.Join(", ", KnownNames())}");
        return 2;
    }
}

var context = new SttRunContext(audio, locale, cli.NoPhrases ? [] : phrases);
var runs = new List<ScoredRun>();

// Sequential on purpose: latency is one of the numbers being compared, and parallel runs would
// make it meaningless.
foreach (var provider in providers)
{
    SttRunResult result;
    try
    {
        result = await provider.RunAsync(context, cancellation.Token);
    }
    catch (OperationCanceledException)
    {
        Console.WriteLine();
        Console.WriteLine("Cancelled.");
        break;
    }
    catch (Exception ex)
    {
        // A provider must never take the whole comparison down.
        result = SttRunResult.Failed(provider.Name, $"unhandled: {ex.Message}");
    }

    var score = MoneyWords.Score(result.Transcript, truth);
    runs.Add(new ScoredRun(result, score));
    PrintRun(result, score);
}

PrintSummary(runs, truth.Count > 0);

if (!cli.NoWrite && runs.Count > 0)
{
    try
    {
        var directory = Path.IsPathRooted(cli.OutputDirectory)
            ? cli.OutputDirectory
            : Path.Combine(RepositoryRoot(), cli.OutputDirectory);

        var reportPath = ReportWriter.Write(
            directory, audio, locale, context.Phrases, truthPath, truth, runs);

        Console.WriteLine();
        Console.WriteLine($"  report  {reportPath}");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"  report  could not be written: {ex.Message}");
    }
}

CleanUp(audio);
return 0;

IReadOnlyList<string> LoadPhrases(CliOptions cliOptions)
{
    if (cliOptions.NoPhrases)
    {
        return [];
    }

    if (cliOptions.PhrasesPath is null)
    {
        return DemoVocabulary.ForProject(cliOptions.Project);
    }

    if (!File.Exists(cliOptions.PhrasesPath))
    {
        Console.Error.WriteLine($"Phrase file not found, falling back to the built-in vocabulary: {cliOptions.PhrasesPath}");
        return DemoVocabulary.ForProject(cliOptions.Project);
    }

    return File.ReadAllLines(cliOptions.PhrasesPath)
        .Select(line => line.Trim())
        .Where(line => line.Length > 0 && !line.StartsWith('#'))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();
}

(string? Path, IReadOnlyList<MoneyWord> Terms) LoadTruth(CliOptions cliOptions)
{
    var path = cliOptions.TruthPath ?? MoneyWords.DefaultTruthPath(cliOptions.AudioPath);

    if (!File.Exists(path))
    {
        if (cliOptions.TruthPath is not null)
        {
            Console.Error.WriteLine($"Ground-truth file not found: {path}");
        }

        return (null, []);
    }

    return (path, MoneyWords.Load(path));
}

void PrintPreflight(
    PreparedAudio prepared,
    string runLocale,
    IReadOnlyList<string> runPhrases,
    string? runTruthPath,
    IReadOnlyList<MoneyWord> runTruth,
    SttOptions runOptions)
{
    var duration = prepared.Duration is null ? string.Empty : $", {Format.Duration(prepared.Duration.Value)}";

    Console.WriteLine();
    Console.WriteLine("Teren STT spike — roadmap A1");
    Console.WriteLine();
    Console.WriteLine($"  file      {Path.GetFileName(prepared.OriginalPath)}  ({prepared.Container}, {Format.Bytes(prepared.BytesOnDisk)}{duration})");
    Console.WriteLine($"  pcm       {(prepared.HasPcm ? prepared.PcmSource : "unavailable — " + prepared.PcmUnavailableReason)}");
    Console.WriteLine($"  locale    {runLocale}");
    Console.WriteLine($"  phrases   {(cli.NoPhrases ? "disabled (--no-phrases)" : $"{runPhrases.Count} terms")}");
    Console.WriteLine($"  truth     {(runTruth.Count == 0 ? "none — pass --truth <file> to score the money words" : $"{runTruth.Count} money words from {Path.GetFileName(runTruthPath)}")}");

    // Keys are never echoed, not even masked: this output gets pasted into notes and issues.
    var configured = new List<string>();
    if (runOptions.Azure.IsConfigured(out _))
    {
        configured.Add($"azure ({runOptions.Azure.Region})");
    }

    if (!string.IsNullOrWhiteSpace(runOptions.OpenAi.Key))
    {
        configured.Add("openai");
    }

    if (!string.IsNullOrWhiteSpace(runOptions.ElevenLabs.Key))
    {
        configured.Add("elevenlabs");
    }

    if (!string.IsNullOrWhiteSpace(runOptions.LocalWhisper.BaseUrl))
    {
        configured.Add("local-whisper");
    }

    Console.WriteLine($"  keys      {(configured.Count == 0 ? "none configured" : string.Join(", ", configured))}");
    Console.WriteLine();
}

void PrintRun(SttRunResult result, MoneyWordScore score)
{
    var rule = new string('─', 74);
    var status = result.Status switch
    {
        SttStatus.Ok => $"ok   {Format.Latency(result.Latency)}",
        SttStatus.Skipped => "skipped",
        _ => "FAILED",
    };

    Console.WriteLine(rule);
    Console.WriteLine($"{result.Provider,-40}{status,34}");
    Console.WriteLine(rule);

    if (result.Status != SttStatus.Ok)
    {
        Console.WriteLine($"  {result.Detail}");
        Console.WriteLine();
        return;
    }

    if (!string.IsNullOrWhiteSpace(result.Detail))
    {
        Console.WriteLine($"  ({result.Detail})");
    }

    Console.WriteLine();
    Console.WriteLine(Wrap(result.Transcript!, 74));
    Console.WriteLine();

    if (score.HasTerms)
    {
        Console.WriteLine($"  money words  {score.Line}");
        if (score.Misses.Count > 0)
        {
            // The misses, not the score, are what A3 decides on.
            Console.WriteLine($"  missed       {string.Join("  ·  ", score.Misses)}");
        }
    }

    Console.WriteLine();
}

void PrintSummary(IReadOnlyList<ScoredRun> results, bool scored)
{
    if (results.Count == 0)
    {
        return;
    }

    Console.WriteLine(new string('═', 74));
    Console.WriteLine("Summary");
    Console.WriteLine();

    foreach (var run in results)
    {
        var status = run.Result.Status switch
        {
            SttStatus.Ok => "ok",
            SttStatus.Skipped => "skipped",
            _ => "FAILED",
        };

        var latency = run.Result.Status == SttStatus.Ok ? Format.Latency(run.Result.Latency) : string.Empty;
        var score = scored && run.Result.Status == SttStatus.Ok
            ? $"{run.Score.Found}/{run.Score.Total}"
            : string.Empty;

        Console.WriteLine($"  {run.Result.Provider,-26}{status,-10}{latency,10}{score,10}");
    }

    if (results.All(r => r.Result.Status == SttStatus.Skipped))
    {
        Console.WriteLine();
        Console.WriteLine("  Nothing ran. Configure at least one provider, for example:");
        Console.WriteLine("    dotnet user-secrets --project tools/SttSpike set \"Stt:Azure:Key\" \"<key>\"");
        Console.WriteLine("    dotnet user-secrets --project tools/SttSpike set \"Stt:Azure:Region\" \"westeurope\"");
    }
}

static void CleanUp(PreparedAudio prepared)
{
    if (prepared.Pcm16kMonoWavPath is null)
    {
        return;
    }

    try
    {
        File.Delete(prepared.Pcm16kMonoWavPath);
    }
    catch (IOException)
    {
        // A leftover temp file is harmless.
    }
}

static IEnumerable<string> KnownNames() =>
[
    "azure-fast", "azure-continuous", "azure-continuous+hints",
    "openai-whisper", "elevenlabs-scribe", "local-whisper", "google-stt",
];

/// <summary>
/// Walks up from the executable so a relative <c>docs/stt-output</c> lands in the repository no
/// matter which directory the tool was started from.
/// </summary>
static string RepositoryRoot()
{
    var directory = new DirectoryInfo(AppContext.BaseDirectory);

    while (directory is not null)
    {
        if (File.Exists(Path.Combine(directory.FullName, "Teren.slnx"))
            || Directory.Exists(Path.Combine(directory.FullName, ".git")))
        {
            return directory.FullName;
        }

        directory = directory.Parent;
    }

    return Directory.GetCurrentDirectory();
}

static string Wrap(string text, int width)
{
    var builder = new StringBuilder();
    var lineLength = 0;

    foreach (var word in text.Split(' ', StringSplitOptions.RemoveEmptyEntries))
    {
        if (lineLength > 0 && lineLength + word.Length + 1 > width)
        {
            builder.AppendLine();
            lineLength = 0;
        }

        if (lineLength > 0)
        {
            builder.Append(' ');
            lineLength++;
        }

        builder.Append(word);
        lineLength += word.Length;
    }

    return builder.ToString();
}
