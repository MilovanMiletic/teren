using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;

namespace SttSpike.Providers;

/// <summary>
/// ElevenLabs Scribe. Reserved slot, implemented because it is one multipart POST and A3 names it
/// as a candidate. Accepts compressed audio, so no local decoding. No phrase-list equivalent.
/// <para>
/// <b>Untested against a live endpoint</b> — see the note on
/// <see cref="OpenAiCompatibleProvider"/>. A failure here means "check the request shape first".
/// </para>
/// </summary>
public sealed class ElevenLabsProvider(ElevenLabsOptions options, HttpClient http) : ISttProvider
{
    public string Name => "elevenlabs-scribe";

    public async Task<SttRunResult> RunAsync(SttRunContext context, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(options.Key))
        {
            return SttRunResult.Skipped(Name, "no Stt:ElevenLabs:Key configured");
        }

        var stopwatch = Stopwatch.StartNew();

        try
        {
            using var form = new MultipartFormDataContent();
            await using var audio = File.OpenRead(context.Audio.OriginalPath);
            var audioPart = new StreamContent(audio);
            var bare = context.Audio.ContentType.Split(';')[0].Trim();
            audioPart.Headers.ContentType = MediaTypeHeaderValue.Parse(
                bare.Length == 0 ? "application/octet-stream" : bare);
            form.Add(audioPart, "file", Path.GetFileName(context.Audio.OriginalPath));
            form.Add(new StringContent(options.Model), "model_id");
            form.Add(new StringContent(options.Language), "language_code");

            using var request = new HttpRequestMessage(
                HttpMethod.Post, "https://api.elevenlabs.io/v1/speech-to-text")
            {
                Content = form,
            };
            request.Headers.Add("xi-api-key", options.Key);

            using var response = await http.SendAsync(request, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            stopwatch.Stop();

            if (!response.IsSuccessStatusCode)
            {
                var trimmed = body.Trim();
                return SttRunResult.Failed(
                    Name,
                    $"ElevenLabs returned {(int)response.StatusCode} {response.StatusCode}"
                    + (trimmed.Length == 0 ? string.Empty : $": {(trimmed.Length <= 400 ? trimmed : trimmed[..400] + "…")}"),
                    stopwatch.Elapsed);
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
            return SttRunResult.Failed(Name, $"could not reach api.elevenlabs.io — {ex.Message}", stopwatch.Elapsed);
        }
        catch (Exception ex)
        {
            return SttRunResult.Failed(Name, ex.Message, stopwatch.Elapsed);
        }
    }
}
