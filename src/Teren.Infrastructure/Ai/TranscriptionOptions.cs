using System.ComponentModel.DataAnnotations;

namespace Teren.Infrastructure.Ai;

/// <summary>
/// Bound from the <c>Stt</c> configuration section. The key names deliberately match the ones
/// the A1/A3 spike used (<c>Stt:Azure:Key</c>, <c>Stt:Azure:Region</c>) so the founder can copy
/// the value straight across from the spike's secret store without re-reading the Azure portal.
/// <para>
/// **A missing key is not a startup failure.** There is no Azure key on every machine that
/// builds this, and an API that refuses to boot without one would make the whole upload path
/// untestable. Startup validates the shape; a missing key surfaces as
/// <see cref="AzureFastTranscriptionProvider.IsConfigured"/> being false, which parks entries in
/// <c>needs_review</c> with an honest reason rather than pretending they were processed.
/// </para>
/// </summary>
public sealed class TranscriptionOptions
{
    public const string SectionName = "Stt";

    public AzureSpeechOptions Azure { get; set; } = new();
}

public sealed class AzureSpeechOptions
{
    /// <summary>Azure AI Speech resource key. Never committed; user-secrets or <c>Stt__Azure__Key</c>.</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>Short region name, e.g. <c>westeurope</c>. Must match the resource the key belongs to.</summary>
    public string Region { get; set; } = string.Empty;

    // There is deliberately no Locale here. It existed, was bound and validated, and was never
    // read: the provider takes its locale from the TranscriptionContext the pipeline builds out
    // of Pipeline:TranscriptionLocale. Two knobs for one setting, one of them inert, is a trap
    // for whoever changes the wrong one at 02:00.

    /// <summary>Fast-transcription API version, overridable so a preview build can be tried.</summary>
    [Required(AllowEmptyStrings = false)]
    public string FastApiVersion { get; set; } = "2024-11-15";

    /// <summary>
    /// Ceiling on one transcription call. Generous: A3 measured ~2 s for 18 s of audio, but a
    /// job can wait and a cut-off call costs a foreman's entry.
    /// </summary>
    [Range(typeof(TimeSpan), "00:00:05", "00:10:00")]
    public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromMinutes(2);

    public bool IsConfigured(out string missing)
    {
        if (string.IsNullOrWhiteSpace(Key))
        {
            missing = "Stt:Azure:Key";
            return false;
        }

        if (string.IsNullOrWhiteSpace(Region))
        {
            missing = "Stt:Azure:Region";
            return false;
        }

        missing = string.Empty;
        return true;
    }
}
