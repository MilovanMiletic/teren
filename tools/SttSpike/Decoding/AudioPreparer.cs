using Concentus;
using Concentus.Oggfile;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace SttSpike.Decoding;

/// <summary>
/// What one run knows about the input file.
/// <para>
/// Two different things are needed from the same recording. The REST providers upload the file
/// untouched — they decode server-side and accept whatever the phone produced. The Azure Speech
/// SDK cannot: it wants 16 kHz mono 16-bit PCM, and its compressed-input path needs GStreamer,
/// which is not a dependency worth putting on a founder's laptop. So the SDK providers (the only
/// ones that support phrase-list hints) get <see cref="Pcm16kMonoWavPath"/>, and when it could
/// not be produced they skip with <see cref="PcmUnavailableReason"/> instead of failing.
/// </para>
/// </summary>
public sealed record PreparedAudio(
    string OriginalPath,
    string Container,
    string ContentType,
    long BytesOnDisk,
    string? Pcm16kMonoWavPath,
    string? PcmUnavailableReason,
    string PcmSource,
    TimeSpan? Duration)
{
    public bool HasPcm => Pcm16kMonoWavPath is not null;
}

public static class AudioPreparer
{
    private const int TargetSampleRate = 16_000;

    /// <summary>
    /// Sniffs the container, then produces 16 kHz mono PCM where it can. Never throws for a
    /// format it cannot handle — the reason travels with the result so providers can skip.
    /// </summary>
    public static PreparedAudio Prepare(string audioPath, string workDir)
    {
        var info = new FileInfo(audioPath);
        var (container, contentType) = Sniff(audioPath);
        Directory.CreateDirectory(workDir);
        var pcmPath = Path.Combine(
            workDir,
            Path.GetFileNameWithoutExtension(audioPath) + ".16k.mono.wav");

        try
        {
            switch (container)
            {
                case "wav":
                    ConvertWithNAudio(audioPath, pcmPath);
                    return Finish(pcmPath, "NAudio (managed WAV read + WDL resample)");

                case "ogg-opus":
                    DecodeOggOpus(audioPath, pcmPath);
                    return Finish(pcmPath, "Concentus (managed Opus decode at 16 kHz)");

                default:
                    // Everything else — m4a/AAC from an iPhone, WebM/Opus from Android Chrome,
                    // mp3, flac — has no managed decoder here. ffmpeg does the job when it is
                    // installed; otherwise only the REST providers can read this file.
                    if (Ffmpeg.TryLocate(out var ffmpegPath))
                    {
                        Ffmpeg.Convert(ffmpegPath, audioPath, pcmPath, TargetSampleRate);
                        return Finish(pcmPath, "ffmpeg");
                    }

                    return Unavailable(
                        $"no managed decoder for '{container}' and ffmpeg is not on PATH — "
                        + "install it (winget install Gyan.FFmpeg) or record/convert to .ogg or .wav");
            }
        }
        catch (Exception ex)
        {
            // A decode failure must not take the run down: the REST providers still work.
            return Unavailable($"could not decode to 16 kHz mono PCM: {ex.Message}");
        }

        PreparedAudio Finish(string path, string source)
        {
            TimeSpan? duration = null;
            try
            {
                using var reader = new WaveFileReader(path);
                duration = reader.TotalTime;
            }
            catch
            {
                // Duration is decoration; never fail the run over it.
            }

            return new PreparedAudio(
                audioPath, container, contentType, info.Length, path, null, source, duration);
        }

        PreparedAudio Unavailable(string why) => new(
            audioPath, container, contentType, info.Length, null, why, "none", null);
    }

    /// <summary>Magic-byte sniff; the extension is only a tie-breaker, because phones lie.</summary>
    private static (string Container, string ContentType) Sniff(string path)
    {
        var buffer = new byte[64];
        int read;
        using (var fs = File.OpenRead(path))
        {
            read = fs.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
        }

        var head = buffer.AsSpan(0, read);

        if (StartsWith(head, "RIFF"u8) && head.Length >= 12 && head[8..12].SequenceEqual("WAVE"u8))
        {
            return ("wav", "audio/wav");
        }

        if (StartsWith(head, "OggS"u8))
        {
            // OpusHead sits in the first page; a Vorbis stream would say "\x01vorbis" instead.
            return head.IndexOf("OpusHead"u8) >= 0
                ? ("ogg-opus", "audio/ogg; codecs=opus")
                : ("ogg", "audio/ogg");
        }

        if (StartsWith(head, [0x1A, 0x45, 0xDF, 0xA3]))
        {
            return ("webm", "audio/webm");
        }

        if (head.Length >= 12 && head[4..8].SequenceEqual("ftyp"u8))
        {
            return ("mp4", "audio/mp4");
        }

        if (StartsWith(head, "fLaC"u8))
        {
            return ("flac", "audio/flac");
        }

        if (StartsWith(head, "ID3"u8) || (head.Length >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0))
        {
            return ("mp3", "audio/mpeg");
        }

        var ext = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
        return (ext.Length == 0 ? "unknown" : ext, "application/octet-stream");

        static bool StartsWith(ReadOnlySpan<byte> haystack, ReadOnlySpan<byte> needle) =>
            haystack.Length >= needle.Length && haystack[..needle.Length].SequenceEqual(needle);
    }

    private static void ConvertWithNAudio(string input, string output)
    {
        using var reader = new WaveFileReader(input);
        ISampleProvider samples = reader.ToSampleProvider();

        if (samples.WaveFormat.Channels == 2)
        {
            samples = new StereoToMonoSampleProvider(samples);
        }
        else if (samples.WaveFormat.Channels > 2)
        {
            throw new NotSupportedException(
                $"{samples.WaveFormat.Channels}-channel audio is not handled; expected mono or stereo");
        }

        if (samples.WaveFormat.SampleRate != TargetSampleRate)
        {
            // WDL resampler, not naive decimation. This harness exists to measure recognition
            // accuracy, so aliasing from a lazy 48k -> 16k downsample would corrupt the result.
            samples = new WdlResamplingSampleProvider(samples, TargetSampleRate);
        }

        WaveFileWriter.CreateWaveFile16(output, samples);
    }

    private static void DecodeOggOpus(string input, string output)
    {
        var channels = ReadOpusHeadChannels(input);

        // Opus decodes internally at 48 kHz and resamples properly on the way out, so asking the
        // decoder for 16 kHz directly is both correct and one processing stage cheaper.
        using var decoder = OpusCodecFactory.CreateDecoder(TargetSampleRate, channels);
        using var source = File.OpenRead(input);
        var ogg = new OpusOggReadStream(decoder, source);

        using var writer = new WaveFileWriter(output, new WaveFormat(TargetSampleRate, 16, 1));
        var wroteAnything = false;

        while (ogg.HasNextPacket)
        {
            var packet = ogg.DecodeNextPacket();
            if (packet is null || packet.Length == 0)
            {
                continue;
            }

            if (channels == 1)
            {
                writer.WriteSamples(packet, 0, packet.Length);
            }
            else
            {
                // Interleaved -> mono average, so a stereo recording does not lose half its level.
                var frames = packet.Length / channels;
                var mono = new short[frames];
                for (var i = 0; i < frames; i++)
                {
                    var sum = 0;
                    for (var c = 0; c < channels; c++)
                    {
                        sum += packet[(i * channels) + c];
                    }

                    mono[i] = (short)(sum / channels);
                }

                writer.WriteSamples(mono, 0, mono.Length);
            }

            wroteAnything = true;
        }

        if (!wroteAnything)
        {
            throw new InvalidDataException(
                $"no Opus packets decoded ({ogg.LastError ?? "no error reported"})");
        }
    }

    /// <summary>
    /// Channel count from the OpusHead identification header (byte 9 of the packet). Guessing it
    /// wrong silently yields garbage audio, which is exactly the failure this harness must not
    /// have — a bad transcript would be blamed on the provider.
    /// </summary>
    private static int ReadOpusHeadChannels(string path)
    {
        var buffer = new byte[4096];
        using var fs = File.OpenRead(path);
        var read = fs.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
        var index = buffer.AsSpan(0, read).IndexOf("OpusHead"u8);

        if (index < 0 || index + 9 >= read)
        {
            throw new InvalidDataException("OpusHead header not found in the first Ogg page");
        }

        var channels = buffer[index + 9];
        return channels is >= 1 and <= 2
            ? channels
            : throw new NotSupportedException(
                $"OpusHead declares {channels} channels; expected 1 or 2");
    }
}
