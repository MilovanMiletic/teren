using System.Diagnostics;
using System.Text;
using Microsoft.CognitiveServices.Speech;
using Microsoft.CognitiveServices.Speech.Audio;

namespace SttSpike.Providers;

/// <summary>
/// Azure AI Speech real-time engine via the Speech SDK, optionally with a phrase list.
/// <para>
/// <b>Continuous recognition, not <c>RecognizeOnceAsync</c>.</b> The single-shot call stops at the
/// first substantial pause (~15 s of audio in practice), which would silently truncate every
/// 30-second-plus site note and make the provider look far worse than it is. Here recognition runs
/// to end of stream and the <c>Recognized</c> segments are concatenated.
/// </para>
/// <para>
/// <b>Why this exists next to fast transcription:</b> phrase lists. Azure is the only shortlisted
/// candidate that accepts recognition hints, and that is the main reason it is on the list at all
/// — trade jargon ("štemovanje"), material codes ("PPR cev 25") and worker names ("Nenad") are
/// precisely the words a general Serbian model has never seen. This provider is run twice, with
/// and without hints, so A3 can measure what hinting is actually worth.
/// </para>
/// <para>
/// <b>Cost:</b> the SDK reads 16 kHz mono PCM. Its compressed-input path needs GStreamer on
/// Windows, which is not a dependency worth having, so this provider skips (never fails) when
/// <see cref="Decoding.PreparedAudio.Pcm16kMonoWavPath"/> could not be produced.
/// </para>
/// </summary>
public sealed class AzureContinuousProvider(AzureOptions options, bool useHints) : ISttProvider
{
    private static readonly TimeSpan Budget = TimeSpan.FromMinutes(5);

    public string Name => useHints ? "azure-continuous+hints" : "azure-continuous";

    public async Task<SttRunResult> RunAsync(SttRunContext context, CancellationToken ct)
    {
        if (!options.IsConfigured(out var missing))
        {
            return SttRunResult.Skipped(Name, $"no {missing} configured");
        }

        if (!context.Audio.HasPcm)
        {
            return SttRunResult.Skipped(
                Name,
                $"needs 16 kHz mono PCM — {context.Audio.PcmUnavailableReason}");
        }

        if (useHints && context.Phrases.Count == 0)
        {
            return SttRunResult.Skipped(Name, "no phrase list for this run");
        }

        var stopwatch = Stopwatch.StartNew();
        try
        {
            var speechConfig = SpeechConfig.FromSubscription(options.Key, options.Region);
            speechConfig.SpeechRecognitionLanguage = context.Locale;
            speechConfig.OutputFormat = OutputFormat.Detailed;
            speechConfig.SetProfanity(ProfanityOption.Raw);

            // Site audio starts with engine noise and hesitation far more often than with clean
            // speech; the default initial-silence timeout would end the session before the
            // foreman gets going.
            speechConfig.SetProperty(PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "10000");
            speechConfig.SetProperty(PropertyId.Speech_SegmentationSilenceTimeoutMs, "1200");

            using var audioConfig = AudioConfig.FromWavFileInput(context.Audio.Pcm16kMonoWavPath!);
            using var recognizer = new SpeechRecognizer(speechConfig, audioConfig);

            // Applied to the recognizer before recognition starts; the grammar is owned by the
            // recognizer's lifetime, so it is not disposed separately.
            if (useHints)
            {
                var grammar = PhraseListGrammar.FromRecognizer(recognizer);
                foreach (var phrase in context.Phrases)
                {
                    grammar.AddPhrase(phrase);
                }
            }

            var transcript = new StringBuilder();
            var finished = new TaskCompletionSource<CancellationDetails?>(
                TaskCreationOptions.RunContinuationsAsynchronously);

            recognizer.Recognized += (_, e) =>
            {
                if (e.Result.Reason == ResultReason.RecognizedSpeech
                    && !string.IsNullOrWhiteSpace(e.Result.Text))
                {
                    if (transcript.Length > 0)
                    {
                        transcript.Append(' ');
                    }

                    transcript.Append(e.Result.Text.Trim());
                }
            };

            recognizer.Canceled += (_, e) =>
            {
                // End of stream is the normal way a file-backed session finishes.
                if (e.Reason == CancellationReason.EndOfStream)
                {
                    finished.TrySetResult(null);
                    return;
                }

                finished.TrySetResult(CancellationDetails.FromResult(e.Result));
            };

            recognizer.SessionStopped += (_, _) => finished.TrySetResult(null);

            await recognizer.StartContinuousRecognitionAsync().WaitAsync(ct);

            CancellationDetails? cancellation;
            try
            {
                cancellation = await finished.Task.WaitAsync(Budget, ct);
            }
            catch (TimeoutException)
            {
                return SttRunResult.Failed(
                    Name, $"recognition did not finish within {Budget.TotalMinutes:0} minutes",
                    stopwatch.Elapsed);
            }
            finally
            {
                try
                {
                    await recognizer.StopContinuousRecognitionAsync().WaitAsync(TimeSpan.FromSeconds(15), ct);
                }
                catch
                {
                    // Best effort; the run's result is already decided.
                }
            }

            stopwatch.Stop();

            if (cancellation is not null)
            {
                return SttRunResult.Failed(Name, Explain(cancellation), stopwatch.Elapsed);
            }

            var text = transcript.ToString().Trim();
            var detail = useHints ? $"{context.Phrases.Count} phrase hints" : null;

            return text.Length == 0
                ? SttRunResult.Failed(Name, "Azure recognised no speech in this file", stopwatch.Elapsed)
                : SttRunResult.Ok(Name, text, stopwatch.Elapsed, detail);
        }
        catch (Exception ex) when (ex is DllNotFoundException or TypeInitializationException)
        {
            return SttRunResult.Failed(
                Name,
                "the Azure Speech SDK native library failed to load — "
                + $"the REST provider (azure-fast) still works. {ex.Message}",
                stopwatch.Elapsed);
        }
        catch (Exception ex)
        {
            return SttRunResult.Failed(Name, ex.Message, stopwatch.Elapsed);
        }
    }

    /// <summary>Turns an SDK cancellation into a sentence the founder can act on.</summary>
    private static string Explain(CancellationDetails details)
    {
        var lead = details.ErrorCode switch
        {
            CancellationErrorCode.AuthenticationFailure =>
                "Azure rejected the key. Check Stt:Azure:Key and that Stt:Azure:Region matches the resource",
            CancellationErrorCode.ConnectionFailure =>
                "Could not connect to Azure Speech — check the network and that Stt:Azure:Region is a real region",
            CancellationErrorCode.Forbidden =>
                "Azure refused the request — the key may be for a different region or a non-Speech resource",
            CancellationErrorCode.TooManyRequests => "Rate limited by Azure",
            CancellationErrorCode.BadRequest =>
                "Azure rejected the request — most often an unsupported locale or a malformed audio stream",
            CancellationErrorCode.ServiceUnavailable => "Azure Speech is unavailable right now",
            _ => $"Azure cancelled recognition ({details.ErrorCode})",
        };

        var extra = details.ErrorDetails?.Trim();
        if (string.IsNullOrEmpty(extra))
        {
            return lead;
        }

        // The SDK appends a websocket/session dump; the first line carries the meaning.
        var firstLine = extra.Split('\n', 2)[0].Trim();
        return $"{lead}: {firstLine}";
    }
}
