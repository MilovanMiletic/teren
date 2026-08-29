using SttSpike.Decoding;

namespace SttSpike.Providers;

public enum SttStatus
{
    /// <summary>A transcript came back.</summary>
    Ok,

    /// <summary>Not configured, or not usable for this input. Expected, never an error.</summary>
    Skipped,

    /// <summary>Configured and attempted, but the provider or the network said no.</summary>
    Failed,
}

public sealed record SttRunResult(
    string Provider,
    SttStatus Status,
    string? Transcript,
    TimeSpan Latency,
    string? Detail)
{
    public static SttRunResult Skipped(string provider, string reason) =>
        new(provider, SttStatus.Skipped, null, TimeSpan.Zero, reason);

    public static SttRunResult Failed(string provider, string reason, TimeSpan latency = default) =>
        new(provider, SttStatus.Failed, null, latency, reason);

    public static SttRunResult Ok(string provider, string transcript, TimeSpan latency, string? detail = null) =>
        new(provider, SttStatus.Ok, transcript, latency, detail);
}

public sealed record SttRunContext(
    PreparedAudio Audio,
    string Locale,
    IReadOnlyList<string> Phrases);

/// <summary>
/// A candidate transcription path. "Provider" here means an endpoint/configuration combination,
/// not a vendor: Azure contributes three entries because the whole point of A3 is to compare
/// Fast Transcription against the real-time engine, with and without phrase-list hints.
/// </summary>
public interface ISttProvider
{
    string Name { get; }

    Task<SttRunResult> RunAsync(SttRunContext context, CancellationToken ct);
}
