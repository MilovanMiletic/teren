using Microsoft.Extensions.Configuration;

namespace SttSpike.Providers;

/// <summary>
/// Azure AI Speech. Configuration keys are fixed by the founder's setup notes — do not rename:
/// <c>Stt:Azure:Key</c>, <c>Stt:Azure:Region</c>, <c>Stt:Azure:Locale</c>.
/// </summary>
public sealed class AzureOptions
{
    public string Key { get; set; } = string.Empty;

    /// <summary>Short region name, e.g. <c>westeurope</c>.</summary>
    public string Region { get; set; } = string.Empty;

    public string Locale { get; set; } = "sr-RS";

    /// <summary>Fast-transcription API version; overridable so a preview build can be tried.</summary>
    public string FastApiVersion { get; set; } = "2024-11-15";

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

/// <summary>
/// Any endpoint speaking OpenAI's <c>/audio/transcriptions</c> shape: OpenAI itself, and the
/// self-hosted whisper servers (faster-whisper-server, whisper.cpp) that copy it. One class
/// covers both slots because the only difference is the base URL and whether a key is needed.
/// </summary>
public sealed class OpenAiCompatibleOptions
{
    public string Key { get; set; } = string.Empty;

    public string BaseUrl { get; set; } = string.Empty;

    public string Model { get; set; } = string.Empty;

    /// <summary>ISO-639-1, so <c>sr</c> rather than the full <c>sr-RS</c> locale.</summary>
    public string Language { get; set; } = "sr";
}

public sealed class ElevenLabsOptions
{
    public string Key { get; set; } = string.Empty;

    public string Model { get; set; } = "scribe_v1";

    public string Language { get; set; } = "srp";
}

public sealed class SttOptions
{
    public AzureOptions Azure { get; init; } = new();

    public OpenAiCompatibleOptions OpenAi { get; init; } = new();

    public OpenAiCompatibleOptions LocalWhisper { get; init; } = new();

    public ElevenLabsOptions ElevenLabs { get; init; } = new();

    /// <summary>
    /// Google STT slot. Google needs a service-account credential flow rather than a header key,
    /// which is not cheap enough to build before A3 needs it; this only records whether the
    /// founder has configured anything, so the run can say so instead of staying silent.
    /// </summary>
    public string GoogleCredentialsPath { get; init; } = string.Empty;

    public static SttOptions Load(IConfiguration configuration)
    {
        var stt = configuration.GetSection("Stt");

        var options = new SttOptions
        {
            Azure = stt.GetSection("Azure").Get<AzureOptions>() ?? new AzureOptions(),
            OpenAi = stt.GetSection("OpenAi").Get<OpenAiCompatibleOptions>() ?? new OpenAiCompatibleOptions(),
            LocalWhisper = stt.GetSection("LocalWhisper").Get<OpenAiCompatibleOptions>() ?? new OpenAiCompatibleOptions(),
            ElevenLabs = stt.GetSection("ElevenLabs").Get<ElevenLabsOptions>() ?? new ElevenLabsOptions(),
            GoogleCredentialsPath = stt["Google:CredentialsPath"] ?? string.Empty,
        };

        // Defaults survive a section that exists but leaves the field blank.
        if (string.IsNullOrWhiteSpace(options.Azure.Locale))
        {
            options.Azure.Locale = "sr-RS";
        }

        if (string.IsNullOrWhiteSpace(options.Azure.FastApiVersion))
        {
            options.Azure.FastApiVersion = "2024-11-15";
        }

        if (string.IsNullOrWhiteSpace(options.OpenAi.BaseUrl))
        {
            options.OpenAi.BaseUrl = "https://api.openai.com/v1";
        }

        if (string.IsNullOrWhiteSpace(options.OpenAi.Model))
        {
            options.OpenAi.Model = "whisper-1";
        }

        if (string.IsNullOrWhiteSpace(options.LocalWhisper.Model))
        {
            options.LocalWhisper.Model = "Systran/faster-whisper-large-v3";
        }

        return options;
    }
}
