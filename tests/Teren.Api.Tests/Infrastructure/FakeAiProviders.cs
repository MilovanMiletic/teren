using System.Collections.Concurrent;
using Teren.Core.Ai;
using Teren.Core.Processing;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Transcription stopped at the interface ARCHITECTURE §9.1 put there.
/// <para>
/// Its default answer is deliberately **Cyrillic**, because that is what Azure actually returns
/// for <c>sr-RS</c>, and the pipeline's transliteration step is only proved by a fake that lies
/// the same way the real service does.
/// </para>
/// </summary>
public sealed class FakeTranscriptionProvider : ITranscriptionProvider
{
    /// <summary>The 18-second A3 test sentence, in the script Azure returns it in.</summary>
    public const string CyrillicTranscript =
        "Данас смо завршили развод топле и хладне воде од котла до купатила, 40 метара "
        + "пипр цеви дваес 5. Уградили смо 6 водокотлића Геберит. Били смо тројица — Ненад, "
        + "Зоран и Милош. Чека се штемовање од електричара.";

    private readonly ConcurrentQueue<TranscriptionContext> _calls = new();

    public string Name => "fake-stt";

    public bool Configured { get; set; } = true;

    public bool IsConfigured => Configured;

    /// <summary>What a successful call returns.</summary>
    public string Transcript { get; set; } = CyrillicTranscript;

    /// <summary>When set, every call throws this instead of answering.</summary>
    public Func<Exception>? Fails { get; set; }

    /// <summary>
    /// Runs while the pass is inside this call — the seam a test needs to make the world change
    /// *during* a slow external call rather than before or after one. Everything interesting
    /// about a pass outliving <c>StaleProcessingAfter</c> happens exactly here.
    /// </summary>
    public Func<Task>? WhileCalling { get; set; }

    /// <summary>How many attempts fail before the provider starts succeeding.</summary>
    public int FailFirstAttempts { get; set; }

    public IReadOnlyList<TranscriptionContext> Calls => [.. _calls];

    public int CallCount => _calls.Count;

    /// <summary>The bytes the last successful call was handed — proof a retry got a fresh stream.</summary>
    public byte[]? LastAudio { get; private set; }

    public void Reset()
    {
        _calls.Clear();
        Configured = true;
        Transcript = CyrillicTranscript;
        Fails = null;
        WhileCalling = null;
        FailFirstAttempts = 0;
        LastAudio = null;
    }

    public async Task<TranscriptResult> TranscribeAsync(
        Stream audio, TranscriptionContext context, CancellationToken ct)
    {
        _calls.Enqueue(context);

        if (WhileCalling is not null)
        {
            await WhileCalling();
        }

        if (!Configured)
        {
            throw new AiProviderNotConfiguredException(Name, "Stt:Azure:Key");
        }

        if (_calls.Count <= FailFirstAttempts)
        {
            throw new AiProviderException(Name, "transient test failure", retryable: true);
        }

        if (Fails is not null)
        {
            throw Fails();
        }

        // Reading it is the point: a retry handed the same consumed stream would read zero bytes.
        using var buffer = new MemoryStream();
        await audio.CopyToAsync(buffer, ct);
        LastAudio = buffer.ToArray();

        return new TranscriptResult(Transcript, TimeSpan.FromMilliseconds(20));
    }
}

/// <summary>
/// Structure extraction stopped at the interface ARCHITECTURE §9.2 put there. **This is the only
/// extractor any test uses: no real Claude call is made anywhere in this suite.** What is proved
/// here is the pipeline's contract with an extractor — what it passes in, where it stores the
/// answer, and what it does when the call fails — not the model's judgement.
/// </summary>
public sealed class FakeStructureExtractor : IStructureExtractor
{
    private readonly ConcurrentQueue<ExtractionContext> _calls = new();

    /// <summary>A plausible v1 answer for <see cref="FakeTranscriptionProvider.CyrillicTranscript"/>,
    /// including the canonical material name recovered from the site vocabulary — the mapping the
    /// product now depends on (<c>docs/stt-evaluation.md</c>).</summary>
    public const string SampleStructure =
        """
        {"schema_version":1,
         "work_done":[{"description":"Razvod tople i hladne vode od kotla do kupatila",
                       "location":null,
                       "quantity":{"value":40,"unit":"m"}}],
         "headcount":{"total":3,"roles":[{"role":"vodoinstalater","count":3}]},
         "materials":[{"name":"PPR cev 25mm","quantity":{"value":40,"unit":"m"},"delivered":null},
                      {"name":"ugradni vodokotlić Geberit Duofix","quantity":{"value":6,"unit":"kom"},"delivered":null}],
         "blockers":[{"description":"čeka se štemovanje","waiting_on":"električari"}],
         "hidden_work":[],
         "notes":null}
        """;

    public string Name => "fake-extractor";

    public bool Configured { get; set; } = true;

    public bool IsConfigured => Configured;

    public string Json { get; set; } = SampleStructure;

    public Func<Exception>? Fails { get; set; }

    /// <summary>
    /// Runs while the pass is inside this call. This is the seam the stale-claim tests need: the
    /// model is the slow step, so "the world moved on mid-pass" means "the world moved on here".
    /// </summary>
    public Func<Task>? WhileCalling { get; set; }

    public int FailFirstAttempts { get; set; }

    public IReadOnlyList<ExtractionContext> Calls => [.. _calls];

    public int CallCount => _calls.Count;

    public void Reset()
    {
        _calls.Clear();
        Configured = true;
        Json = SampleStructure;
        Fails = null;
        WhileCalling = null;
        FailFirstAttempts = 0;
    }

    public async Task<ExtractionResult> ExtractAsync(
        ExtractionContext context, CancellationToken ct)
    {
        _calls.Enqueue(context);

        if (WhileCalling is not null)
        {
            await WhileCalling();
        }

        if (!Configured)
        {
            throw new AiProviderNotConfiguredException(Name, "Anthropic:ApiKey");
        }

        if (_calls.Count <= FailFirstAttempts)
        {
            throw new AiProviderException(Name, "transient test failure", retryable: true);
        }

        if (Fails is not null)
        {
            throw Fails();
        }

        return new ExtractionResult(Json, "fake-model", TimeSpan.FromMilliseconds(30), 100, 50);
    }
}

/// <summary>
/// The queue seam, recording instead of scheduling. It is what makes "a ready <c>/complete</c>
/// hands the entry to the pipeline" an assertion rather than a hope, without a Hangfire server
/// in the test host.
/// </summary>
public sealed class RecordingPipelineQueue : IPipelineQueue
{
    private readonly ConcurrentQueue<(Guid EntryId, Guid CompanyId)> _enqueued = new();

    public IReadOnlyList<(Guid EntryId, Guid CompanyId)> Enqueued => [.. _enqueued];

    public void Reset() => _enqueued.Clear();

    public void EnqueueProcessing(Guid entryId, Guid companyId) =>
        _enqueued.Enqueue((entryId, companyId));
}
