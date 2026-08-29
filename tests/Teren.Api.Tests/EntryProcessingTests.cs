using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Ai;
using Teren.Core.Entities;
using Teren.Core.Processing;
using Teren.Infrastructure.Processing;

namespace Teren.Api.Tests;

/// <summary>
/// B4: the processing pipeline. Everything here runs the real <c>EntryProcessor</c> against the
/// real Postgres schema — triggers, CHECK constraints and tenant filters included — with the two
/// external services faked at their interfaces.
/// <para>
/// **No real Azure or Anthropic call is made by any test in this suite.** What is proved is the
/// state machine, the evidence obligations B3 handed over, and that failure always ends
/// somewhere a human can see.
/// </para>
/// </summary>
public sealed class EntryProcessingTests(TerenTestApp app) : ApiTestBase(app)
{
    // ------------------------------------------------------------ the happy path

    [Fact]
    public async Task A_completed_entry_goes_received_to_awaiting_confirmation()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        var outcome = await ProcessAsync(entryId);

        outcome.ShouldBe(EntryProcessingOutcome.Processed);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.AwaitingConfirmation);
        entry.Structure.ShouldNotBeNull();
        entry.RawTranscript.ShouldNotBeNullOrWhiteSpace();
        entry.FailureReason.ShouldBeNull();
        entry.ProcessingStartedAt.ShouldBeNull();

        // The human's column is untouched: confirmation is the only thing that writes it.
        entry.Corrected.ShouldBeNull();
    }

    [Fact]
    public async Task The_stored_transcript_is_latin_even_though_the_provider_returns_cyrillic()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        await ProcessAsync(entryId);

        var transcript = (await LoadEntryAsync(entryId))!.RawTranscript!;

        // The founder decision in ARCHITECTURE §14 item 8, proved end to end rather than only in
        // the transliterator's own unit tests.
        transcript.ShouldContain("Danas smo završili razvod tople i hladne vode");
        transcript.ShouldNotContain("Данас");
    }

    [Fact]
    public async Task The_extractor_is_given_the_transcript_and_the_sites_vocabulary()
    {
        // The load-bearing part of §9.2: without this site's material list the model cannot map
        // "pipr cevi dvaes 5" back to "PPR cev 25mm", and A3 proved no STT path will do it.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        await ProcessAsync(entryId);

        var call = App.Extractor.Calls.ShouldHaveSingleItem();
        call.Transcript.ShouldContain("Danas smo završili");
        call.ProjectName.ShouldBe("Stambena zgrada Vojvode Stepe 212");
        call.EntryDate.ShouldBe(Wire.Today);
    }

    [Fact]
    public async Task The_pipeline_stores_exactly_what_the_extractor_returned()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Json = """{"schema_version":1,"notes":"samo beleška"}""";

        await ProcessAsync(entryId);

        var structure = (await LoadEntryAsync(entryId))!.Structure!;
        structure.ShouldContain("samo beleška");
    }

    // ------------------------------------------------------------ pickup predicate

    [Fact]
    public async Task An_entry_without_a_receipt_is_not_picked_up()
    {
        // ARCHITECTURE §6: received_at means the server holds the *complete* entry. An entry
        // whose uploads are still climbing must never be transcribed.
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));

        var outcome = await ProcessAsync(entryId);

        outcome.ShouldBe(EntryProcessingOutcome.Skipped);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.Received);
        App.Transcription.CallCount.ShouldBe(0);
    }

    [Theory]
    [InlineData(EntryStatus.Processing)]
    [InlineData(EntryStatus.AwaitingConfirmation)]
    [InlineData(EntryStatus.Confirmed)]
    [InlineData(EntryStatus.NeedsReview)]
    public async Task An_entry_that_is_not_received_is_not_picked_up(EntryStatus status)
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            status: status, receivedAt: DateTime.UtcNow));

        var outcome = await ProcessAsync(entryId);

        outcome.ShouldBe(EntryProcessingOutcome.Skipped);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(status);
        App.Transcription.CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task A_second_worker_handed_the_same_entry_does_no_work()
    {
        // The claim is a conditional UPDATE precisely so two workers cannot both pass the check.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Processed);
        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Skipped);

        App.Transcription.CallCount.ShouldBe(1);
        App.Extractor.CallCount.ShouldBe(1);
    }

    [Fact]
    public async Task Another_tenants_entry_is_invisible_to_the_pipeline()
    {
        // The job carries a company id and sets the tenant from it; the global filters do the
        // rest. Handing the wrong company must find nothing, not somebody else's evidence.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        var outcome = await ProcessAsync(entryId, TestIds.CompanyB);

        outcome.ShouldBe(EntryProcessingOutcome.Skipped);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.Received);
    }

    // ------------------------------------------------------------ evidence obligations

    [Fact]
    public async Task A_checksum_mismatch_parks_the_entry_and_never_transcribes_it()
    {
        // B3 verified size only, deliberately (ARCHITECTURE §6). This is the first moment anyone
        // reads the bytes, so it is the first moment the declared SHA-256 can be checked — and a
        // mismatch must never be silent.
        var entryId = Guid.NewGuid();
        var declared = Wire.AudioBytes("what-the-phone-hashed");
        var audioId = await GivenCompletedEntryWithAudioAsync(entryId, declared);

        // Same length, different content: size verification at /complete cannot see this.
        var tampered = Wire.AudioBytes("what-storage-actually-holds", declared.Length);
        var audio = (await LoadMediaAsync(entryId)).Single(m => m.Id == audioId);
        Storage.PutObject(audio.ObjectKey, tampered);

        var outcome = await ProcessAsync(entryId);

        outcome.ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        ProcessingFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ProcessingFailure.AudioChecksumMismatch);
        entry.RawTranscript.ShouldBeNull();
        entry.ProcessingStartedAt.ShouldBeNull();

        // Bytes that are not the evidence the record claims are never sent anywhere.
        App.Transcription.CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task A_stored_object_of_the_wrong_size_parks_the_entry()
    {
        var entryId = Guid.NewGuid();
        var declared = Wire.AudioBytes();
        var audioId = await GivenCompletedEntryWithAudioAsync(entryId, declared);

        var audio = (await LoadMediaAsync(entryId)).Single(m => m.Id == audioId);
        Storage.PutObject(audio.ObjectKey, Wire.AudioBytes("shorter", declared.Length / 2));

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        ProcessingFailure.CodeOf(entry!.FailureReason)
            .ShouldBe(ProcessingFailure.AudioChecksumMismatch);
    }

    [Fact]
    public async Task An_object_that_disappeared_after_completion_parks_the_entry()
    {
        var entryId = Guid.NewGuid();
        var audioId = await GivenCompletedEntryWithAudioAsync(entryId);

        var audio = (await LoadMediaAsync(entryId)).Single(m => m.Id == audioId);
        Storage.RemoveObject(audio.ObjectKey);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        ProcessingFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ProcessingFailure.AudioMissing);
    }

    [Fact]
    public async Task An_entry_with_no_media_and_no_text_parks_rather_than_becoming_an_empty_report()
    {
        // /complete allows a media-less entry to keep the typed-shorthand fallback open. This is
        // where that permission is paid for.
        var entryId = await GivenEntryAsync();
        (await CompleteAsync(entryId)).EnsureSuccessStatusCode();

        var outcome = await ProcessAsync(entryId);

        outcome.ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        ProcessingFailure.CodeOf(entry.FailureReason).ShouldBe(ProcessingFailure.NoEvidence);
        entry.Structure.ShouldBeNull();

        App.Transcription.CallCount.ShouldBe(0);
        App.Extractor.CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task An_entry_with_typed_text_and_no_audio_skips_transcription_and_extracts()
    {
        // The other half of the media-less case: a foreman who typed his note still gets a
        // structured entry, and no recording is invented for him.
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            receivedAt: DateTime.UtcNow,
            rawTranscript: "Zavrsili razvod, 40 m PPR cevi. Bili smo trojica."));

        var outcome = await ProcessAsync(entryId);

        outcome.ShouldBe(EntryProcessingOutcome.Processed);
        App.Transcription.CallCount.ShouldBe(0);
        App.Extractor.CallCount.ShouldBe(1);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.AwaitingConfirmation);
    }

    // ------------------------------------------------------------ failure is never loss

    [Fact]
    public async Task Transcription_failing_parks_the_entry_with_no_transcript_and_the_audio_intact()
    {
        var entryId = Guid.NewGuid();
        var audioId = await GivenCompletedEntryWithAudioAsync(entryId);
        App.Transcription.Fails =
            () => new AiProviderException("fake-stt", "the service is confused", retryable: false);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        ProcessingFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ProcessingFailure.TranscriptionFailed);

        // The evidence itself is untouched — the foreman's recording is still there to retry or
        // to listen to.
        (await LoadMediumAsync(audioId))!.UploadStatus.ShouldBe(MediaUploadStatus.Verified);
    }

    [Fact]
    public async Task Extraction_failing_still_leaves_the_foreman_his_words()
    {
        // The single most important promise in this increment: a broken model call costs the
        // structure, never the transcript.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Fails =
            () => new AiProviderException("fake-extractor", "overloaded", retryable: false);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        entry.RawTranscript!.ShouldContain("Danas smo završili");
        entry.Structure.ShouldBeNull();
        ProcessingFailure.CodeOf(entry.FailureReason).ShouldBe(ProcessingFailure.ExtractionFailed);
    }

    [Fact]
    public async Task A_missing_transcription_key_parks_honestly_instead_of_marking_the_entry_done()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Transcription.Configured = false;

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        ProcessingFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ProcessingFailure.TranscriptionNotConfigured);
        entry.FailureReason!.ShouldContain("Stt:Azure:Key");
    }

    [Fact]
    public async Task A_missing_extraction_key_keeps_the_transcript_and_parks_honestly()
    {
        // This is the state of the founder's machine today: no Anthropic key. It must produce a
        // visible, explicable entry — not a crash, and above all not a silent success.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Configured = false;

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        entry.RawTranscript.ShouldNotBeNullOrWhiteSpace();
        entry.Structure.ShouldBeNull();
        ProcessingFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ProcessingFailure.ExtractionNotConfigured);
        entry.FailureReason!.ShouldContain("Anthropic:ApiKey");
    }

    [Fact]
    public async Task A_model_answer_that_is_not_a_v1_structure_never_reaches_the_database()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        // No schema_version: the Postgres CHECK would reject it too, but the pipeline must catch
        // it first and turn it into a reason a human can read.
        App.Extractor.Json = """{"work_done":[]}""";
        App.Extractor.Fails = () => new AiProviderException(
            "fake-extractor", "the model answered but the extracted structure has no numeric schema_version",
            retryable: false,
            kind: AiFailureKind.UnusableAnswer);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        var entry = await LoadEntryAsync(entryId);
        entry!.Structure.ShouldBeNull();
        ProcessingFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ProcessingFailure.ExtractionInvalid);
    }

    // ------------------------------------------------- failure codes, not English prose

    // The B4 review's F3. These two failures used to be recognised by
    // `ex.Message.Contains("no speech")` and `Contains("the model answered but")` — so rewording
    // one sentence would have silently downgraded what the phone shows a foreman in Serbian,
    // with nothing failing anywhere. The wording below is deliberately nothing like the real
    // provider's: only AiFailureKind decides.

    [Fact]
    public async Task A_recording_with_no_speech_is_recognised_by_kind_not_by_its_wording()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Transcription.Fails = () => new AiProviderException(
            "fake-stt",
            "tišina — a sentence sharing not one word with the real provider's",
            retryable: false,
            kind: AiFailureKind.UnusableAnswer);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        ProcessingFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ProcessingFailure.TranscriptionEmpty);
    }

    [Fact]
    public async Task A_model_that_answered_unusably_is_recognised_by_kind_not_by_its_wording()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Fails = () => new AiProviderException(
            "fake-extractor",
            "unparseable answer, phrased however today's SDK phrases it",
            retryable: false,
            kind: AiFailureKind.UnusableAnswer);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        ProcessingFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ProcessingFailure.ExtractionInvalid);
    }

    [Fact]
    public async Task A_call_that_simply_failed_stays_a_plain_failure()
    {
        // The other half of the classification: an ordinary broken call must not be reported as
        // "we heard nothing", which would tell the foreman to re-record a perfectly good note.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Transcription.Fails = () => new AiProviderException(
            "fake-stt", "no speech service reachable", retryable: false);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        // Note the message even contains "no speech". The kind is what decides.
        ProcessingFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ProcessingFailure.TranscriptionFailed);
    }

    [Fact]
    public async Task Storage_being_unreachable_parks_the_entry_rather_than_looping_forever()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        Storage.Unreachable = true;

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        ProcessingFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ProcessingFailure.StorageUnavailable);
    }

    // ------------------------------------------------------------ retries, bounded

    [Fact]
    public async Task A_transient_transcription_failure_is_retried_and_then_succeeds()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Transcription.FailFirstAttempts = 2;

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Processed);

        App.Transcription.CallCount.ShouldBe(3);

        // A retry must hand the provider a fresh stream; the same consumed one would read empty.
        App.Transcription.LastAudio.ShouldNotBeNull();
        App.Transcription.LastAudio!.Length.ShouldBe(Wire.AudioBytes().Length);
    }

    [Fact]
    public async Task Retries_are_bounded_and_end_in_needs_review()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Fails =
            () => new AiProviderException("fake-extractor", "still overloaded", retryable: true);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Parked);

        // Pipeline:MaxAttempts is 3. Never four, and never forever.
        App.Extractor.CallCount.ShouldBe(3);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.NeedsReview);
    }

    [Fact]
    public async Task A_terminal_failure_is_not_retried()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Fails =
            () => new AiProviderException("fake-extractor", "bad api key", retryable: false);

        await ProcessAsync(entryId);

        App.Extractor.CallCount.ShouldBe(1);
    }

    // ------------------------------------------------------------ resume

    [Fact]
    public async Task A_re_run_after_a_failed_extraction_reuses_the_stored_transcript()
    {
        // raw_transcript is write-once and trigger-enforced; a second pass must not try to
        // rewrite it, and must not pay for transcription twice.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Fails =
            () => new AiProviderException("fake-extractor", "overloaded", retryable: false);

        await ProcessAsync(entryId);

        var transcript = (await LoadEntryAsync(entryId))!.RawTranscript;

        // Put the entry back in the pipeline's way, as a re-queue after a fix would.
        await SetStatusAsync(entryId, EntryStatus.Received);
        App.Extractor.Fails = null;

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Processed);

        var entry = await LoadEntryAsync(entryId);
        entry!.RawTranscript.ShouldBe(transcript);
        entry.Status.ShouldBe(EntryStatus.AwaitingConfirmation);
        App.Transcription.CallCount.ShouldBe(1);
    }

    // ------------------------------------------------------------ the stale-claim race

    // Three tests for one bug, found in the B4 review. A pass can outlive
    // Pipeline:StaleProcessingAfter — one brownout at Azure or Anthropic is enough — and the
    // sweeper then parks it as abandoned while it is still running. The foreman sees
    // needs_review, which /confirm deliberately accepts, and confirms. If the worker's terminal
    // writes were unconditional, its late answer would then drag a *confirmed* entry back to
    // awaiting_confirmation with confirmed_at still stamped: the entry silently drops out of the
    // set B6 reports from, and nothing anywhere says so.
    //
    // The claim, not the clock, is the authority. A pass that no longer holds `processing`
    // writes nothing.

    [Fact]
    public async Task A_pass_that_lost_its_claim_cannot_undo_a_confirmation()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        // Everything below happens while the model is thinking — i.e. inside the pass.
        App.Extractor.WhileCalling = async () =>
        {
            await SetProcessingStartedAsync(entryId, DateTime.UtcNow.AddHours(-2));
            (await SweepAsync()).Parked.ShouldBe(1);

            var confirmed = await ConfirmAsync(entryId, Corrected());
            confirmed.StatusCode.ShouldBe(
                HttpStatusCode.OK, await confirmed.TextAsync());
        };

        var outcome = await ProcessAsync(entryId);

        // The corruption first, because it is the thing that matters: an unconditional terminal
        // write lands here as `confirmed` -> `awaiting_confirmation`, confirmed_at still stamped.
        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(
            EntryStatus.Confirmed,
            "a late worker must never drag a confirmed entry back out of the reportable set");

        // It succeeded at extraction and still wrote nothing: the entry is not its any more.
        outcome.ShouldBe(EntryProcessingOutcome.Skipped);

        entry.ConfirmedAt.ShouldNotBeNull();
        entry.Corrected.ShouldNotBeNull();
        entry.FailureReason.ShouldBeNull();

        // The human's answer is intact and the late model answer was dropped rather than
        // half-applied — `structure` is still empty because extraction finished too late to
        // count.
        entry.Structure.ShouldBeNull();
    }

    [Fact]
    public async Task A_pass_that_lost_its_claim_cannot_park_a_confirmed_entry()
    {
        // The same race down the failure path: the worker's *park* is a write too, and parking a
        // confirmed entry into needs_review is the same silent loss with a different status.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        App.Extractor.WhileCalling = async () =>
        {
            await SetProcessingStartedAsync(entryId, DateTime.UtcNow.AddHours(-2));
            (await SweepAsync()).Parked.ShouldBe(1);
            (await ConfirmAsync(entryId, Corrected())).EnsureSuccessStatusCode();
        };
        App.Extractor.Fails =
            () => new AiProviderException("fake-extractor", "overloaded", retryable: false);

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Skipped);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ConfirmedAt.ShouldNotBeNull();
        // Not re-stamped with the pipeline's failure: the human already dealt with this entry.
        entry.FailureReason.ShouldBeNull();
    }

    [Fact]
    public async Task A_pass_whose_claim_is_taken_during_transcription_stops_before_extraction()
    {
        // Losing the claim earlier costs less if it is noticed earlier: there is no reason to
        // pay Anthropic for an answer the terminal write is going to refuse. The transcript is
        // still written — it is raw evidence, it is write-once, and it changes no status.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        App.Transcription.WhileCalling = async () =>
        {
            await SetProcessingStartedAsync(entryId, DateTime.UtcNow.AddHours(-2));
            (await SweepAsync()).Parked.ShouldBe(1);
        };

        (await ProcessAsync(entryId)).ShouldBe(EntryProcessingOutcome.Skipped);

        App.Extractor.CallCount.ShouldBe(0);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        ProcessingFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ProcessingFailure.ProcessingInterrupted);
        entry.RawTranscript!.ShouldContain("Danas smo završili");
    }

    // ------------------------------------------------------------ the enqueue seam

    [Fact]
    public async Task A_ready_complete_hands_the_entry_to_the_pipeline()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);

        App.Pipeline.Enqueued.ShouldHaveSingleItem()
            .ShouldBe((entryId, TestIds.CompanyA));
    }

    [Fact]
    public async Task A_complete_that_is_not_ready_enqueues_nothing()
    {
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));

        await CompleteAsync(entryId);

        App.Pipeline.Enqueued.ShouldBeEmpty();
    }

    /// <summary>What a foreman approves on the confirmation screen — the shape, not the content.</summary>
    private static JsonObject Corrected() => new()
    {
        ["schema_version"] = 1,
        ["notes"] = "ukucao sam sam jer sistem nije stigao",
    };

    private async Task SetStatusAsync(Guid entryId, EntryStatus status)
    {
        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
        entry.Status = status;
        entry.FailureReason = null;
        await db.SaveChangesAsync(Ct);
    }
}
