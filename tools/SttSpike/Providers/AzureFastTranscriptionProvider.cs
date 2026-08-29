using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace SttSpike.Providers;

/// <summary>
/// Azure AI Speech <em>fast transcription</em> REST API.
/// <para>
/// This is the path that solves both Azure gotchas at once. It takes the whole file in one
/// request, so there is no 15-second <c>RecognizeOnceAsync</c> ceiling to work around, and it
/// decodes server-side, so a 30-second m4a from an iPhone or WebM/Opus from Android needs no
/// local decoder, no GStreamer and no ffmpeg.
/// </para>
/// <para>
/// What it cannot do is phrase-list hints — the <c>definition</c> payload has no field for them.
/// That is why <see cref="AzureContinuousProvider"/> exists alongside it.
/// </para>
/// </summary>
public sealed class AzureFastTranscriptionProvider(AzureOptions options, HttpClient http) : ISttProvider
{
    public string Name => "azure-fast";

    public async Task<SttRunResult> RunAsync(SttRunContext context, CancellationToken ct)
    {
        if (!options.IsConfigured(out var missing))
        {
            return SttRunResult.Skipped(Name, $"no {missing} configured");
        }

        var url =
            $"https://{options.Region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe"
            + $"?api-version={options.FastApiVersion}";

        var definition = JsonSerializer.Serialize(new
        {
            locales = new[] { context.Locale },
            profanityFilterMode = "None",
        });

        var stopwatch = Stopwatch.StartNew();
        try
        {
            using var form = new MultipartFormDataContent();
            await using var audio = File.OpenRead(context.Audio.OriginalPath);
            var audioPart = new StreamContent(audio);
            audioPart.Headers.ContentType =
                MediaTypeHeaderValue.Parse(NormalizeContentType(context.Audio.ContentType));
            form.Add(audioPart, "audio", Path.GetFileName(context.Audio.OriginalPath));
            form.Add(new StringContent(definition), "definition");

            using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = form };
            request.Headers.Add("Ocp-Apim-Subscription-Key", options.Key);

            using var response = await http.SendAsync(request, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            stopwatch.Stop();

            if (!response.IsSuccessStatusCode)
            {
                return SttRunResult.Failed(Name, Explain(response.StatusCode, body), stopwatch.Elapsed);
            }

            var transcript = ExtractTranscript(body);
            return string.IsNullOrWhiteSpace(transcript)
                ? SttRunResult.Failed(Name, "Azure returned no speech for this file", stopwatch.Elapsed)
                : SttRunResult.Ok(Name, transcript, stopwatch.Elapsed);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return SttRunResult.Failed(Name, "request timed out", stopwatch.Elapsed);
        }
        catch (HttpRequestException ex)
        {
            return SttRunResult.Failed(
                Name,
                $"could not reach {options.Region}.api.cognitive.microsoft.com — {ex.Message}",
                stopwatch.Elapsed);
        }
        catch (Exception ex)
        {
            return SttRunResult.Failed(Name, ex.Message, stopwatch.Elapsed);
        }
    }

    /// <summary>
    /// Azure's error bodies are the most useful diagnostic this harness has (an unsupported
    /// locale, for instance, only shows up there), so the body is surfaced rather than swallowed
    /// — but trimmed, and always behind a sentence a human can act on.
    /// </summary>
    private static string Explain(HttpStatusCode status, string body)
    {
        var detail = Summarize(body);

        var lead = status switch
        {
            HttpStatusCode.Unauthorized =>
                "Azure rejected the key (401). Check Stt:Azure:Key and that Stt:Azure:Region matches the resource",
            HttpStatusCode.Forbidden =>
                "Azure refused the request (403) — wrong region for this key, or the resource is not a Speech resource",
            HttpStatusCode.NotFound =>
                "Endpoint not found (404) — check Stt:Azure:Region, and whether fast transcription is offered there",
            HttpStatusCode.BadRequest =>
                "Azure rejected the request (400) — most often the locale or the audio container",
            HttpStatusCode.TooManyRequests => "Rate limited by Azure (429)",
            _ => $"Azure returned {(int)status} {status}",
        };

        return detail.Length == 0 ? lead : $"{lead}: {detail}";
    }

    private static string Summarize(string body)
    {
        var trimmed = body.Trim();
        if (trimmed.Length == 0)
        {
            return string.Empty;
        }

        try
        {
            using var document = JsonDocument.Parse(trimmed);
            if (document.RootElement.TryGetProperty("error", out var error)
                && error.TryGetProperty("message", out var message))
            {
                return message.GetString() ?? string.Empty;
            }
        }
        catch (JsonException)
        {
            // Not JSON — fall through and show the raw text.
        }

        return trimmed.Length <= 400 ? trimmed : trimmed[..400] + "…";
    }

    private static string ExtractTranscript(string body)
    {
        using var document = JsonDocument.Parse(body);

        // Preferred shape: combinedPhrases[0].text is the whole recording as one string.
        if (document.RootElement.TryGetProperty("combinedPhrases", out var combined)
            && combined.ValueKind == JsonValueKind.Array
            && combined.GetArrayLength() > 0
            && combined[0].TryGetProperty("text", out var combinedText))
        {
            return combinedText.GetString()?.Trim() ?? string.Empty;
        }

        // Fallback: stitch the per-phrase texts, so a response-shape change degrades to a
        // slightly uglier transcript rather than to nothing.
        if (document.RootElement.TryGetProperty("phrases", out var phrases)
            && phrases.ValueKind == JsonValueKind.Array)
        {
            var parts = phrases.EnumerateArray()
                .Select(p => p.TryGetProperty("text", out var t) ? t.GetString() : null)
                .Where(t => !string.IsNullOrWhiteSpace(t));

            return string.Join(' ', parts).Trim();
        }

        return string.Empty;
    }

    /// <summary>
    /// <c>audio/ogg; codecs=opus</c> is a perfectly good content type but the parameter buys
    /// nothing here, and some gateways dislike it in a multipart part header.
    /// </summary>
    private static string NormalizeContentType(string contentType)
    {
        var semicolon = contentType.IndexOf(';');
        var bare = semicolon < 0 ? contentType : contentType[..semicolon];
        return string.IsNullOrWhiteSpace(bare) ? "application/octet-stream" : bare.Trim();
    }
}
