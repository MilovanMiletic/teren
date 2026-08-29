namespace Teren.Core.Ai;

/// <summary>
/// Speech to text (ARCHITECTURE §9.1). One interface so the vendor is a one-file change:
/// nothing else in the pipeline knows who transcribes.
/// </summary>
public interface ITranscriptionProvider
{
    /// <summary>Name used in logs and in <c>failure_reason</c>. Never a secret, never a URL.</summary>
    string Name { get; }

    /// <summary>
    /// Whether this provider has the configuration it needs. False is an honest, expected state
    /// on a machine with no key — the pipeline parks the entry in <c>needs_review</c> rather
    /// than pretending it processed it.
    /// </summary>
    bool IsConfigured { get; }

    /// <summary>
    /// Transcribes one recording. Called only from a Hangfire job (PROJECT.md principle 4).
    /// Throws <see cref="AiProviderException"/> — with <see cref="AiProviderException.Retryable"/>
    /// telling the caller whether trying again could ever help.
    /// </summary>
    Task<TranscriptResult> TranscribeAsync(
        Stream audio, TranscriptionContext context, CancellationToken ct);
}

/// <summary>
/// What the provider needs to know about the recording it is given.
/// <para>
/// <see cref="Vocabulary"/> is carried because §9.1 puts it here, but note the A3 finding
/// (<c>docs/stt-evaluation.md</c>): Azure's phrase lists proved **inert for <c>sr-RS</c>** —
/// hinted and unhinted runs came back byte-identical. The Azure provider therefore does not
/// send it, and recovery of mangled material codes happens downstream in the extraction call.
/// The field stays so a future provider that does honour hints needs no signature change.
/// </para>
/// </summary>
public sealed record TranscriptionContext(
    string Locale,
    string ContentType,
    string? FileName = null,
    string? Vocabulary = null);

/// <summary>
/// A transcript, in the language that was spoken (never translated — PROJECT.md principle 2).
/// <see cref="Text"/> has already been transliterated to Latin by the pipeline, not by the
/// provider: providers return what the vendor returns.
/// </summary>
public sealed record TranscriptResult(string Text, TimeSpan Latency, string? Detail = null);
