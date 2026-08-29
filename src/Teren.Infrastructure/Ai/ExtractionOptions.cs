using System.ComponentModel.DataAnnotations;

namespace Teren.Infrastructure.Ai;

/// <summary>
/// Bound from the <c>Anthropic</c> configuration section.
/// <para>
/// <see cref="Model"/> is validated at startup and <see cref="ApiKey"/> deliberately is not, for
/// the same reason as <see cref="TranscriptionOptions"/>: an empty model name is a deployment
/// mistake nobody wants to discover at 02:00, while a missing key is the ordinary state of a
/// development machine. A host that refused to boot without an Anthropic key would make the
/// entire upload path — which needs no key at all — impossible to run or test.
/// </para>
/// </summary>
public sealed class ExtractionOptions
{
    public const string SectionName = "Anthropic";

    /// <summary>Never committed. user-secrets in development, <c>Anthropic__ApiKey</c> in production.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Extraction model, from configuration and never hardcoded (ARCHITECTURE §9.2). Starts on
    /// Sonnet 5 — short-transcript normalisation with a human waiting — and moves to Opus 5 if
    /// the eval set shows Serbian trade jargon slipping. That choice is settled by measured
    /// quality, never by price: per-entry cost is cents against EUR 30-80 per site per month.
    /// </summary>
    [Required(AllowEmptyStrings = false)]
    public string Model { get; set; } = "claude-sonnet-5";

    [Range(1024, 32000)]
    public int MaxTokens { get; set; } = 4000;

    /// <summary>
    /// Ceiling on one extraction call. A human is waiting on the confirmation screen, but a job
    /// that gives up early costs him the extraction entirely.
    /// </summary>
    [Range(typeof(TimeSpan), "00:00:10", "00:10:00")]
    public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromMinutes(3);

    public bool IsConfigured(out string missing)
    {
        if (string.IsNullOrWhiteSpace(ApiKey))
        {
            missing = "Anthropic:ApiKey";
            return false;
        }

        missing = string.Empty;
        return true;
    }
}
