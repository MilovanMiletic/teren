using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Ai;

namespace Teren.Infrastructure.Ai;

/// <summary>
/// Azure AI Speech <em>fast transcription</em> (REST), locale <c>sr-RS</c> — the provider A3
/// chose (<c>docs/stt-evaluation.md</c>). Ported from the proven spike at
/// <c>tools/SttSpike/Providers/AzureFastTranscriptionProvider.cs</c>.
/// <para>
/// Why this path and not the real-time engine: it takes the whole file in one request, so there
/// is no 15-second <c>RecognizeOnce</c> ceiling, and it decodes server-side, so an m4a from an
/// iPhone or WebM/Opus from Android needs no ffmpeg on our box. A3 measured it 3.5x faster than
/// the continuous path and closer on the one token that matters.
/// </para>
/// <para>
/// What it deliberately does <em>not</em> do is send phrase-list hints. Fast transcription has
/// no field for them, and A3 proved they are inert for <c>sr-RS</c> anyway — hinted and unhinted
/// continuous runs came back byte-identical across 39 phrases. Building hint plumbing into the
/// product path would be machinery for an effect that does not exist. Canonical names are
/// recovered downstream, in the extraction call.
/// </para>
/// </summary>
public sealed class AzureFastTranscriptionProvider(
    IOptions<TranscriptionOptions> options,
    IHttpClientFactory httpClientFactory,
    ILogger<AzureFastTranscriptionProvider> logger) : ITranscriptionProvider
{
    /// <summary>The named client, so the timeout and handler lifetime are configured once in DI.</summary>
    public const string HttpClientName = "azure-speech";

    private readonly AzureSpeechOptions _azure = options.Value.Azure;

    public string Name => "azure-fast";

    public bool IsConfigured => _azure.IsConfigured(out _);

    public async Task<TranscriptResult> TranscribeAsync(
        Stream audio, TranscriptionContext context, CancellationToken ct)
    {
        if (!_azure.IsConfigured(out var missing))
        {
            throw new AiProviderNotConfiguredException(Name, missing);
        }

        var url =
            $"https://{_azure.Region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe"
            + $"?api-version={_azure.FastApiVersion}";

        // locales, not a single locale: the API takes a list. profanityFilterMode None because a
        // foreman's own words are the evidence — masking them alters the record.
        var definition = JsonSerializer.Serialize(new
        {
            locales = new[] { context.Locale },
            profanityFilterMode = "None",
        });

        var http = httpClientFactory.CreateClient(HttpClientName);
        var stopwatch = Stopwatch.StartNew();

        try
        {
            using var form = new MultipartFormDataContent();
            var audioPart = new StreamContent(audio);
            audioPart.Headers.ContentType =
                MediaTypeHeaderValue.Parse(NormaliseContentType(context.ContentType));
            form.Add(audioPart, "audio", context.FileName ?? "audio");
            form.Add(new StringContent(definition), "definition");

            using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = form };
            request.Headers.Add("Ocp-Apim-Subscription-Key", _azure.Key);

            using var response = await http.SendAsync(request, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            stopwatch.Stop();

            if (!response.IsSuccessStatusCode)
            {
                throw new AiProviderException(
                    Name, Explain(response.StatusCode, body), IsRetryable(response.StatusCode));
            }

            var transcript = ExtractTranscript(body);

            if (string.IsNullOrWhiteSpace(transcript))
            {
                // The service answered and heard nothing. Trying again cannot change that, and
                // the entry belongs in front of a human with its audio intact. The kind, not the
                // wording of this sentence, is what becomes `transcription_empty` downstream.
                throw new AiProviderException(
                    Name,
                    "no speech was recognised in this recording",
                    retryable: false,
                    kind: AiFailureKind.UnusableAnswer);
            }

            logger.LogInformation(
                "Transcribed audio in {ElapsedMs} ms via {Provider} ({Locale}).",
                stopwatch.ElapsedMilliseconds, Name, context.Locale);

            return new TranscriptResult(transcript.Trim(), stopwatch.Elapsed);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            // The HttpClient timeout, not the job being cancelled. Worth another attempt.
            throw new AiProviderException(
                Name,
                $"the request did not complete within {_azure.RequestTimeout.TotalSeconds:0.#} s",
                retryable: true);
        }
        catch (HttpRequestException ex)
        {
            throw new AiProviderException(
                Name, $"could not reach the speech service: {ex.Message}", retryable: true, ex);
        }
    }

    /// <summary>
    /// Whether trying the same call again could ever work. A rejected key or an unsupported
    /// locale never becomes valid by repetition; a 429 or a 5xx routinely does.
    /// </summary>
    private static bool IsRetryable(HttpStatusCode status) =>
        status is HttpStatusCode.TooManyRequests or HttpStatusCode.RequestTimeout
        || (int)status >= 500;

    /// <summary>
    /// The error body is the most useful diagnostic available (an unsupported locale shows up
    /// nowhere else), so it is surfaced — trimmed, and behind a sentence a human can act on.
    /// The subscription key is never part of any of this.
    /// </summary>
    private static string Explain(HttpStatusCode status, string body)
    {
        var detail = Summarise(body);

        var lead = status switch
        {
            HttpStatusCode.Unauthorized =>
                "the speech service rejected the key (401) — check Stt:Azure:Key and that "
                + "Stt:Azure:Region matches the resource",
            HttpStatusCode.Forbidden =>
                "the speech service refused the request (403) — wrong region for this key, or "
                + "the resource is not a Speech resource",
            HttpStatusCode.NotFound =>
                "endpoint not found (404) — check Stt:Azure:Region, and whether fast "
                + "transcription is offered there",
            HttpStatusCode.BadRequest =>
                "the speech service rejected the request (400) — most often the locale or the "
                + "audio container",
            HttpStatusCode.TooManyRequests => "rate limited by the speech service (429)",
            _ => $"the speech service returned {(int)status} {status}",
        };

        return detail.Length == 0 ? lead : $"{lead}: {detail}";
    }

    private static string Summarise(string body)
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
            // Not JSON — show the raw text instead of losing the diagnostic.
        }

        return trimmed.Length <= 400 ? trimmed : trimmed[..400] + "...";
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
    /// <c>audio/ogg; codecs=opus</c> is a valid content type but the parameter buys nothing here,
    /// and some gateways dislike it in a multipart part header.
    /// </summary>
    private static string NormaliseContentType(string contentType)
    {
        var semicolon = contentType.IndexOf(';');
        var bare = semicolon < 0 ? contentType : contentType[..semicolon];
        return string.IsNullOrWhiteSpace(bare) ? "application/octet-stream" : bare.Trim();
    }
}
