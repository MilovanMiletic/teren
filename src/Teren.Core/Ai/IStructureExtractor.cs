namespace Teren.Core.Ai;

/// <summary>
/// Transcript → structured entry (ARCHITECTURE §9.2). Behind an interface for the same reason
/// as transcription, and because the pipeline must be provable without an API key.
/// </summary>
public interface IStructureExtractor
{
    string Name { get; }

    /// <summary>False when no API key is configured. See <see cref="ITranscriptionProvider.IsConfigured"/>.</summary>
    bool IsConfigured { get; }

    /// <summary>
    /// Extracts the v1 entry structure. Returns the JSON to store verbatim in
    /// <c>entry.structure</c> — it is validated against <see cref="EntryStructureSchema"/> by
    /// the model's structured-output mode, and re-checked here for <c>schema_version</c> before
    /// it ever reaches Postgres.
    /// </summary>
    Task<ExtractionResult> ExtractAsync(ExtractionContext context, CancellationToken ct);
}

/// <summary>
/// Everything the extraction call is allowed to see. <see cref="Vocabulary"/> is this site's
/// own list of work items, materials and worker names, and it is **load-bearing**: A3 found
/// that every Azure path mangled <c>PPR cev 25</c> into <em>pipr cevi dvaes 5</em>, and mapping
/// that back to a canonical name from the site's own material list is the product's mitigation
/// (<c>docs/stt-evaluation.md</c>, ARCHITECTURE §9.2).
/// </summary>
public sealed record ExtractionContext(
    string Transcript,
    string? Vocabulary,
    string? ProjectName,
    DateOnly EntryDate);

/// <summary>The extracted structure as JSON, plus what it cost, for the eval loop (§9.3).</summary>
public sealed record ExtractionResult(
    string Json,
    string Model,
    TimeSpan Latency,
    long? InputTokens = null,
    long? OutputTokens = null);
