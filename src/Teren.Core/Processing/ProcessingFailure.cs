namespace Teren.Core.Processing;

/// <summary>
/// The vocabulary of <c>entry.failure_reason</c>. A stored reason is always
/// <c>"{code}: {detail}"</c> — a stable machine-readable code the UI can translate into Serbian,
/// followed by an English detail for whoever is reading logs.
/// <para>
/// Codes, not sentences, because the phone must be able to tell "the recording was corrupted"
/// from "nobody configured a transcription key" without parsing English prose — the same
/// mistake B3 refused to make when it classified upload failures on status codes rather than
/// on a detail string.
/// </para>
/// </summary>
public static class ProcessingFailure
{
    /// <summary>Nothing to work from: no audio and no typed text. Never becomes an empty report.</summary>
    public const string NoEvidence = "no_evidence";

    /// <summary>The stored audio does not hash to what the phone declared. Evidence integrity
    /// failure — B3's <c>/complete</c> verified size only, deliberately (ARCHITECTURE §6).</summary>
    public const string AudioChecksumMismatch = "audio_checksum_mismatch";

    /// <summary>The object was verified at <c>/complete</c> but is not in storage now.</summary>
    public const string AudioMissing = "audio_missing";

    /// <summary>Storage could not be read at all; the bytes may still be fine.</summary>
    public const string StorageUnavailable = "storage_unavailable";

    public const string TranscriptionNotConfigured = "transcription_not_configured";
    public const string TranscriptionFailed = "transcription_failed";

    /// <summary>The provider answered, but found no speech in the recording.</summary>
    public const string TranscriptionEmpty = "transcription_empty";

    public const string ExtractionNotConfigured = "extraction_not_configured";
    public const string ExtractionFailed = "extraction_failed";

    /// <summary>The model answered, but not with something that is a v1 entry structure.</summary>
    public const string ExtractionInvalid = "extraction_invalid";

    /// <summary>Anything the pipeline did not anticipate. Still visible, still not lost.</summary>
    public const string Unexpected = "unexpected";

    /// <summary>Claimed for processing and never finished — almost always a process restart.</summary>
    public const string ProcessingInterrupted = "processing_interrupted";

    public static string Describe(string code, string detail) => $"{code}: {detail}";

    /// <summary>The code half of a stored reason, for tests and for the UI.</summary>
    public static string CodeOf(string? failureReason)
    {
        if (string.IsNullOrEmpty(failureReason))
        {
            return string.Empty;
        }

        var separator = failureReason.IndexOf(':');
        return separator < 0 ? failureReason : failureReason[..separator];
    }
}
