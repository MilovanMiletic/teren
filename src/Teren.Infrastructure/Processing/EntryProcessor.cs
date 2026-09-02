using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Ai;
using Teren.Core.Entities;
using Teren.Core.Processing;
using Teren.Core.Storage;
using Teren.Core.Tenancy;
using Teren.Core.Text;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Storage;

namespace Teren.Infrastructure.Processing;

public enum EntryProcessingOutcome
{
    /// <summary>
    /// Somebody else has the entry, or it is not eligible, or this pass lost its claim partway
    /// through and its answer was discarded rather than written over whatever happened since.
    /// Not a failure, and never a state change.
    /// </summary>
    Skipped,

    /// <summary>Transcribed, extracted, now <c>awaiting_confirmation</c>.</summary>
    Processed,

    /// <summary>Parked in <c>needs_review</c> with its evidence intact and a reason recorded.</summary>
    Parked,
}

/// <summary>
/// The B4 pipeline: an uploaded entry through STT, then Claude extraction, to
/// <c>awaiting_confirmation</c> — or to <c>needs_review</c>, never to nothing.
/// <para>
/// Separated from the Hangfire job on purpose. This class holds every rule worth testing and
/// knows nothing about a scheduler, so the state machine and both failure paths are provable
/// against real Postgres without a background server running. <see cref="EntryProcessingJob"/>
/// is the thin wrapper that gives it a queue.
/// </para>
/// <para>
/// Two invariants govern everything below. **Failure is never data loss**: whatever raw evidence
/// exists at the moment of failure is kept and made visible, and the entry stops in a state a
/// human can act on. **Retry is bounded**: transient failures get
/// <c>Pipeline:MaxAttempts</c> tries and then the entry goes to a person, because an entry
/// retrying forever is indistinguishable from an entry that was lost.
/// </para>
/// </summary>
public sealed class EntryProcessor(
    TerenDbContext db,
    TenantContext tenant,
    IObjectStorage storage,
    ITranscriptionProvider transcription,
    IStructureExtractor extractor,
    IOptions<PipelineOptions> options,
    ILogger<EntryProcessor> logger)
{
    private readonly PipelineOptions _options = options.Value;

    public async Task<EntryProcessingOutcome> ProcessAsync(
        Guid entryId, Guid companyId, CancellationToken ct)
    {
        // A job has no request and therefore no tenant. Setting it here is what makes every
        // query below run through the ordinary global filters — the pipeline never reaches for
        // IgnoreQueryFilters (ARCHITECTURE §12).
        tenant.CompanyId = companyId;

        using var scope = logger.BeginScope(new Dictionary<string, object>
        {
            ["EntryId"] = entryId,
            ["CompanyId"] = companyId,
        });

        if (!await TryClaimAsync(entryId, ct))
        {
            logger.LogInformation(
                "Entry {EntryId} was not claimed: it is not `received` with a receipt, or another "
                + "worker has it.", entryId);
            return EntryProcessingOutcome.Skipped;
        }

        var entry = await db.Entries.FirstOrDefaultAsync(e => e.Id == entryId, ct);
        if (entry is null)
        {
            // The claim succeeded a moment ago under the same tenant filter, so this cannot
            // happen without something having deleted the row underneath us.
            logger.LogError("Entry {EntryId} vanished after being claimed.", entryId);
            return EntryProcessingOutcome.Skipped;
        }

        try
        {
            return await RunAsync(entry, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The host is shutting down. Leave the entry in `processing`: the sweeper will park
            // it once StaleProcessingAfter passes, which is the visible outcome, and re-queueing
            // during a shutdown would only race the shutdown.
            throw;
        }
        catch (Exception ex)
        {
            // Anything unforeseen still ends with a human looking at the entry, not with a job
            // dying quietly in a dashboard nobody opens.
            logger.LogError(ex, "Entry {EntryId}: unexpected failure in the pipeline.", entryId);
            return await ParkAsync(entry, ProcessingFailure.Unexpected, ex.Message, ct);
        }
    }

    // ------------------------------------------------------------------ the pass

    private async Task<EntryProcessingOutcome> RunAsync(Entry entry, CancellationToken ct)
    {
        var project = await db.Projects
            .AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == entry.ProjectId, ct);

        var audio = await db.Media
            .AsNoTracking()
            .Where(m => m.EntryId == entry.Id && m.Kind == MediaKind.Audio)
            .OrderBy(m => m.CreatedAt)
            .FirstOrDefaultAsync(ct);

        // ---- 1. transcript ------------------------------------------------

        if (entry.RawTranscript is null)
        {
            if (audio is null)
            {
                // Allowed at /complete to keep the typed-shorthand fallback open (ARCHITECTURE
                // §6), and this is where that permission is paid for: no audio and no text is
                // not an entry to report, it is an entry to show a human.
                logger.LogWarning(
                    "Entry {EntryId} has neither audio nor text; parking for review.", entry.Id);
                return await ParkAsync(
                    entry,
                    ProcessingFailure.NoEvidence,
                    "the entry carries no voice note and no typed text",
                    ct);
            }

            byte[] bytes;
            try
            {
                bytes = await WithRetriesAsync(
                    "download", entry.Id, token => DownloadAndVerifyAsync(audio, token), ct);
            }
            catch (EvidenceIntegrityException ex)
            {
                // The kind, not the message: the same verifier serves report generation, which
                // maps the same two facts onto its own photo_* vocabulary.
                var code = ex.Kind == EvidenceIntegrityKind.Missing
                    ? ProcessingFailure.AudioMissing
                    : ProcessingFailure.AudioChecksumMismatch;

                return await ParkAsync(entry, code, ex.Message, ct);
            }
            catch (ObjectStorageUnavailableException ex)
            {
                return await ParkAsync(
                    entry, ProcessingFailure.StorageUnavailable, ex.Message, ct);
            }

            string transcript;
            try
            {
                transcript = await WithRetriesAsync(
                    "transcription",
                    entry.Id,
                    async token =>
                    {
                        // A fresh stream per attempt: an HTTP request consumes the one it is
                        // given, so a retry over the same stream would upload zero bytes.
                        using var audioStream = new MemoryStream(bytes, writable: false);
                        var result = await transcription.TranscribeAsync(
                            audioStream,
                            new TranscriptionContext(
                                _options.TranscriptionLocale,
                                audio.ContentType,
                                $"{audio.Id:D}",
                                project?.Vocabulary),
                            token);
                        return result.Text;
                    },
                    ct);
            }
            catch (AiProviderNotConfiguredException ex)
            {
                logger.LogError(
                    "Entry {EntryId}: transcription is not configured ({Missing}).",
                    entry.Id, ex.Missing);
                return await ParkAsync(
                    entry, ProcessingFailure.TranscriptionNotConfigured, ex.Message, ct);
            }
            catch (AiProviderException ex)
            {
                // Classified on the provider's typed kind, never on its English message: a
                // reworded sentence must not change what the phone shows a foreman in Serbian.
                var code = ex.Kind == AiFailureKind.UnusableAnswer
                    ? ProcessingFailure.TranscriptionEmpty
                    : ProcessingFailure.TranscriptionFailed;

                logger.LogError(ex, "Entry {EntryId}: transcription failed.", entry.Id);
                return await ParkAsync(entry, code, ex.Message, ct);
            }

            // Azure returns Cyrillic; the product is Latin (ARCHITECTURE §14 decision 8). One
            // conversion, at ingestion, before the value is ever stored — the audio stays the
            // untouched evidence and the transcript can always be regenerated from it.
            entry.RawTranscript = SerbianScript.ToLatin(transcript);

            // Persisted before extraction is even attempted. If the model call fails, the
            // foreman still gets his words back, and raw_transcript is write-once from here on
            // (trigger-enforced), so no later pass can overwrite them.
            await db.SaveChangesAsync(ct);

            logger.LogInformation(
                "Entry {EntryId}: transcript stored ({Length} chars) via {Provider}.",
                entry.Id, entry.RawTranscript.Length, transcription.Name);
        }
        else
        {
            logger.LogInformation(
                "Entry {EntryId} already has a transcript; going straight to extraction.",
                entry.Id);
        }

        if (string.IsNullOrWhiteSpace(entry.RawTranscript))
        {
            return await ParkAsync(
                entry,
                ProcessingFailure.NoEvidence,
                "the entry has an empty transcript and nothing else to work from",
                ct);
        }

        // ---- 2. structure -------------------------------------------------

        // Transcription can take minutes, and the sweeper can decide in the meantime that this
        // pass is abandoned. Asking before the expensive call costs one indexed read and saves
        // an extraction whose result would be discarded anyway — the terminal write below would
        // refuse it. The transcript above is written unconditionally on purpose: it is raw
        // evidence, it is write-once, and it changes no status.
        if (!await StillOwnsClaimAsync(entry.Id, ct))
        {
            logger.LogWarning(
                "Entry {EntryId}: the claim was taken (most likely parked as stale) while it was "
                + "being transcribed; stopping before extraction.", entry.Id);
            return EntryProcessingOutcome.Skipped;
        }

        ExtractionResult extraction;
        try
        {
            extraction = await WithRetriesAsync(
                "extraction",
                entry.Id,
                token => extractor.ExtractAsync(
                    new ExtractionContext(
                        entry.RawTranscript!, project?.Vocabulary, project?.Name, entry.EntryDate),
                    token),
                ct);
        }
        catch (AiProviderNotConfiguredException ex)
        {
            logger.LogError(
                "Entry {EntryId}: structure extraction is not configured ({Missing}). The "
                + "transcript is stored and the entry waits for a human.", entry.Id, ex.Missing);
            return await ParkAsync(
                entry, ProcessingFailure.ExtractionNotConfigured, ex.Message, ct);
        }
        catch (AiProviderException ex)
        {
            // Typed kind, not a message substring — see the transcription catch above.
            var code = ex.Kind == AiFailureKind.UnusableAnswer
                ? ProcessingFailure.ExtractionInvalid
                : ProcessingFailure.ExtractionFailed;

            logger.LogError(ex, "Entry {EntryId}: extraction failed.", entry.Id);
            return await ParkAsync(entry, code, ex.Message, ct);
        }

        // `corrected` is deliberately untouched. It is the human's column, written only by
        // /confirm; the (transcript, extracted, corrected) triple is the eval set and one member
        // never overwrites another (ARCHITECTURE §9.3).
        var structureJson = extraction.Json;

        var finished = await db.Entries
            .Where(e => e.Id == entry.Id && e.Status == EntryStatus.Processing)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(e => e.Structure, structureJson)
                    .SetProperty(e => e.Status, EntryStatus.AwaitingConfirmation)
                    .SetProperty(e => e.FailureReason, (string?)null)
                    .SetProperty(e => e.ProcessingStartedAt, (DateTime?)null),
                ct);

        if (finished != 1)
        {
            // The claim is gone: the sweeper parked this pass as stale and a human may already
            // have confirmed the entry. An unconditional write here would drag a `confirmed`
            // entry back to `awaiting_confirmation` — silently dropping it out of the set B6
            // reports from — so the late answer is discarded instead. Loud, because the pass
            // outliving StaleProcessingAfter is itself worth knowing about.
            logger.LogWarning(
                "Entry {EntryId}: extraction finished but the claim was already gone; the "
                + "result is discarded rather than overwriting whatever state the entry is in "
                + "now. The pass most likely outlived Pipeline:StaleProcessingAfter.", entry.Id);
            return EntryProcessingOutcome.Skipped;
        }

        logger.LogInformation(
            "Entry {EntryId} is awaiting confirmation (model {Model}, {ElapsedMs} ms).",
            entry.Id, extraction.Model, (long)extraction.Latency.TotalMilliseconds);

        return EntryProcessingOutcome.Processed;
    }

    // ------------------------------------------------------------------ claim

    /// <summary>
    /// Moves exactly one entry from <c>received</c> to <c>processing</c>, atomically.
    /// <para>
    /// The predicate is ARCHITECTURE §6 verbatim — <c>status = received AND received_at IS NOT
    /// NULL</c> — and it is expressed as a conditional UPDATE rather than a read-then-write so
    /// two workers handed the same entry cannot both pass the check. The loser sees zero rows
    /// affected and goes away.
    /// </para>
    /// </summary>
    private async Task<bool> TryClaimAsync(Guid entryId, CancellationToken ct)
    {
        var claimed = await db.Entries
            .Where(e => e.Id == entryId
                        && e.Status == EntryStatus.Received
                        && e.ReceivedAt != null)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(e => e.Status, EntryStatus.Processing)
                    .SetProperty(e => e.ProcessingStartedAt, DateTime.UtcNow),
                ct);

        return claimed == 1;
    }

    // ------------------------------------------------------------------ evidence

    /// <summary>
    /// Downloads the voice note and verifies the SHA-256 the phone declared.
    /// <para>
    /// The verification itself lives in <see cref="VerifiedMediaReader"/>, shared with report
    /// generation: B3 handed the same obligation to both (ARCHITECTURE §6), and one
    /// implementation is the only way it cannot hold in one place and lapse in the other.
    /// </para>
    /// </summary>
    private Task<byte[]> DownloadAndVerifyAsync(Media audio, CancellationToken ct) =>
        VerifiedMediaReader.ReadAsync(storage, audio, logger, ct);

    // ------------------------------------------------------------------ helpers

    /// <summary>
    /// Bounded retry around one external call, and it is <see cref="BoundedRetry"/> — the same
    /// loop the report pass uses.
    /// <para>
    /// It was a second copy of that loop until 2026-09-02, identical line for line while
    /// <c>BoundedRetry</c>'s own comment claimed to be "the one retry loop in the background
    /// pipeline". Two copies of a retry policy is how the worst-case wall clock of a pass drifts
    /// away from the stale window that is supposed to outlast it — <c>PipelineOptionsTests</c>
    /// recomputes that budget from the shipped defaults, and it can only do so while there is one
    /// place to read them from.
    /// </para>
    /// <para>
    /// Only failures that could plausibly succeed on a second attempt are retried
    /// (<see cref="IsRetryable"/>); a rejected key, a mangled request or a corrupted file are
    /// raised immediately, because repeating them only delays the honest answer.
    /// </para>
    /// <para>
    /// The retry line now names the entry as <c>SubjectId</c> rather than <c>EntryId</c>. It is
    /// still on the line either way: <c>ProcessAsync</c> opens a log scope carrying
    /// <c>EntryId</c>, which is one of the four properties the D5 sink lifts into its own column.
    /// </para>
    /// </summary>
    private Task<T> WithRetriesAsync<T>(
        string operation, Guid entryId, Func<CancellationToken, Task<T>> action, CancellationToken ct) =>
        BoundedRetry.RunAsync(
            operation,
            entryId,
            _options.MaxAttempts,
            _options.RetryDelay,
            IsRetryable,
            logger,
            action,
            ct);

    private static bool IsRetryable(Exception ex) => ex switch
    {
        AiProviderNotConfiguredException => false,
        AiProviderException provider => provider.Retryable,
        ObjectStorageUnavailableException => true,
        // A checksum mismatch is a fact about the bytes; reading them again changes nothing.
        EvidenceIntegrityException => false,
        _ => false,
    };

    /// <summary>
    /// Whether this pass still holds the claim it took at the start — i.e. the row is still
    /// <c>processing</c>. Anything else means the sweeper parked it as stale and somebody, quite
    /// possibly a human, has moved it on since.
    /// </summary>
    private Task<bool> StillOwnsClaimAsync(Guid entryId, CancellationToken ct) =>
        db.Entries.AnyAsync(
            e => e.Id == entryId && e.Status == EntryStatus.Processing, ct);

    /// <summary>
    /// Stops the entry in front of a human. The raw transcript, if one was produced, is already
    /// stored and stays stored; only status and the reason change.
    /// <para>
    /// Conditional on still owning the claim, for the same reason as the success write: a pass
    /// that outlived <c>Pipeline:StaleProcessingAfter</c> has already been parked by the sweeper
    /// and the entry may since have been confirmed by a human. Parking it again would erase that
    /// confirmation. Zero rows affected is therefore not a failure — it is somebody else's
    /// entry now — and the caller gets <see cref="EntryProcessingOutcome.Skipped"/> rather than a
    /// claim to have parked something.
    /// </para>
    /// </summary>
    private async Task<EntryProcessingOutcome> ParkAsync(
        Entry entry, string code, string detail, CancellationToken ct)
    {
        var reason = ProcessingFailure.Describe(code, detail);

        var parked = await db.Entries
            .Where(e => e.Id == entry.Id && e.Status == EntryStatus.Processing)
            .ExecuteUpdateAsync(
                s => s
                    .SetProperty(e => e.Status, EntryStatus.NeedsReview)
                    .SetProperty(e => e.FailureReason, reason)
                    .SetProperty(e => e.ProcessingStartedAt, (DateTime?)null),
                ct);

        if (parked != 1)
        {
            logger.LogWarning(
                "Entry {EntryId} failed with {FailureCode}, but the claim was already gone; the "
                + "entry is left in whatever state it is in now. The pass most likely outlived "
                + "Pipeline:StaleProcessingAfter.", entry.Id, code);
            return EntryProcessingOutcome.Skipped;
        }

        logger.LogWarning(
            "Entry {EntryId} parked in needs_review ({FailureCode}).", entry.Id, code);

        return EntryProcessingOutcome.Parked;
    }
}
