using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace SttSpike.Providers;

/// <summary>
/// The OpenAI <c>/audio/transcriptions</c> shape, used for two of the reserved slots: the hosted
/// Whisper API and a self-hosted whisper server (faster-whisper-server and whisper.cpp both
/// expose this contract).
/// <para>
/// Included because it costs one class and A3's brief names both as candidates. It accepts
/// compressed audio directly, so it needs no local decoding. Whisper has no phrase list; its
/// <c>prompt</c> field is a soft bias over the preceding-context window, which is a different and
/// much weaker mechanism, so it is left off by default — turning it on would flatter Whisper in a
/// comparison whose whole purpose is to be honest about hinting.
/// </para>
/// <para>
/// <b>Only Azure was designed and reasoned about in detail for A1.</b> This slot is untested
/// against a live endpoint; treat a failure here as "check the request shape", not as a verdict
/// on the provider.
/// </para>
/// </summary>
public sealed class OpenAiCompatibleProvider(
    string name,
    OpenAiCompatibleOptions options,
    HttpClient http,
    bool requiresKey) : ISttProvider
{
    public string Name => name;

    public async Task<SttRunResult> RunAsync(SttRunContext context, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(options.BaseUrl))
        {
            return SttRunResult.Skipped(Name, $"no Stt:{ConfigSection}:BaseUrl configured");
        }

        if (requiresKey && string.IsNullOrWhiteSpace(options.Key))
        {
            return SttRunResult.Skipped(Name, $"no Stt:{ConfigSection}:Key configured");
        }

        var url = options.BaseUrl.TrimEnd('/') + "/audio/transcriptions";
        var stopwatch = Stopwatch.StartNew();

        try
        {
            using var form = new MultipartFormDataContent();
            await using var audio = File.OpenRead(context.Audio.OriginalPath);
            var audioPart = new StreamContent(audio);
            audioPart.Headers.ContentType = MediaTypeHeaderValue.Parse(BareContentType(context.Audio.ContentType));
            form.Add(audioPart, "file", Path.GetFileName(context.Audio.OriginalPath));
            form.Add(new StringContent(options.Model), "model");
            form.Add(new StringContent(options.Language), "language");
            form.Add(new StringContent("json"), "response_format");

            using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = form };
            if (!string.IsNullOrWhiteSpace(options.Key))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Key);
            }

            using var response = await http.SendAsync(request, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            stopwatch.Stop();

            if (!response.IsSuccessStatusCode)
            {
                return SttRunResult.Failed(Name, Explain(response.StatusCode, body), stopwatch.Elapsed);
            }

            using var document = JsonDocument.Parse(body);
            var text = document.RootElement.TryGetProperty("text", out var t)
                ? t.GetString()?.Trim()
                : null;

            return string.IsNullOrWhiteSpace(text)
                ? SttRunResult.Failed(Name, "no speech returned for this file", stopwatch.Elapsed)
                : SttRunResult.Ok(Name, text, stopwatch.Elapsed, options.Model);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return SttRunResult.Failed(Name, "request timed out", stopwatch.Elapsed);
        }
        catch (HttpRequestException ex)
        {
            return SttRunResult.Failed(Name, $"could not reach {url} — {ex.Message}", stopwatch.Elapsed);
        }
        catch (Exception ex)
        {
            return SttRunResult.Failed(Name, ex.Message, stopwatch.Elapsed);
        }
    }

    private string ConfigSection => requiresKey ? "OpenAi" : "LocalWhisper";

    private static string Explain(HttpStatusCode status, string body)
    {
        var lead = status switch
        {
            HttpStatusCode.Unauthorized => "The endpoint rejected the key (401)",
            HttpStatusCode.NotFound => "Endpoint not found (404) — check the BaseUrl",
            HttpStatusCode.TooManyRequests => "Rate limited (429)",
            _ => $"Endpoint returned {(int)status} {status}",
        };

        var trimmed = body.Trim();
        if (trimmed.Length == 0)
        {
            return lead;
        }

        return $"{lead}: {(trimmed.Length <= 400 ? trimmed : trimmed[..400] + "…")}";
    }

    private static string BareContentType(string contentType)
    {
        var semicolon = contentType.IndexOf(';');
        var bare = semicolon < 0 ? contentType : contentType[..semicolon];
        return string.IsNullOrWhiteSpace(bare) ? "application/octet-stream" : bare.Trim();
    }
}
