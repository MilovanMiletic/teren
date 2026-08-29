using System.Net;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// Invariants 4 and 5 (ARCHITECTURE §6, §8): <c>/complete</c> is where the server decides it
/// holds the whole entry. A successful pass stamps <c>received_at</c> and seals the evidence
/// set; a failing one distinguishes "not there yet" from "there but wrong"; and storage being
/// unreachable is a "come back shortly" that writes no verdict on anything.
/// </summary>
public sealed class CompleteEntryTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task All_objects_present_and_the_right_size_makes_the_entry_ready()
    {
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()), Wire.Photo(Guid.NewGuid()));
        await GivenUploadsFinishedAsync(entryId);

        var response = await CompleteAsync(entryId);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var body = await response.JsonAsync();
        body.GetProperty("ready").GetBoolean().ShouldBeTrue();
        body.IsNull("reason").ShouldBeTrue();
        body.GetProperty("pending_media").GetArrayLength().ShouldBe(0);
        body.GetProperty("failed_media").GetArrayLength().ShouldBe(0);

        var entry = await LoadEntryAsync(entryId);
        entry!.ReceivedAt.ShouldNotBeNull();
        (await LoadMediaAsync(entryId))
            .ShouldAllBe(m => m.UploadStatus == MediaUploadStatus.Verified);
    }

    [Fact]
    public async Task An_entry_with_no_media_completes()
    {
        // Allowed on purpose, to keep the typed-shorthand fallback open (ARCHITECTURE §6, F3).
        // B4 is the layer that must park a media-less, text-less entry in needs_review.
        var entryId = await GivenEntryAsync();

        var response = await CompleteAsync(entryId);

        (await response.JsonAsync()).GetProperty("ready").GetBoolean().ShouldBeTrue();
        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task An_object_that_has_not_arrived_is_pending_not_failed()
    {
        // A file that is merely late must never get a permanent black mark in the evidence record.
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        var photoId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(audioId), Wire.Photo(photoId));

        var audio = (await LoadMediaAsync(entryId)).Single(m => m.Id == audioId);
        Storage.PutObject(audio.ObjectKey, audio.ByteSize);

        var body = await (await CompleteAsync(entryId)).JsonAsync();

        body.GetProperty("ready").GetBoolean().ShouldBeFalse();
        body.GetGuids("pending_media").ShouldBe([photoId]);
        body.GetProperty("failed_media").GetArrayLength().ShouldBe(0);
        (await LoadMediumAsync(photoId))!.UploadStatus.ShouldBe(MediaUploadStatus.Pending);
        (await LoadMediumAsync(audioId))!.UploadStatus.ShouldBe(MediaUploadStatus.Verified);
        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldBeNull();
    }

    [Fact]
    public async Task An_object_of_the_wrong_size_is_failed_not_pending()
    {
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(audioId));

        var audio = (await LoadMediaAsync(entryId)).Single();
        Storage.PutObject(audio.ObjectKey, audio.ByteSize - 1);

        var body = await (await CompleteAsync(entryId)).JsonAsync();

        body.GetProperty("ready").GetBoolean().ShouldBeFalse();
        body.GetGuids("failed_media").ShouldBe([audioId]);
        body.GetProperty("pending_media").GetArrayLength().ShouldBe(0);
        body.GetText("reason").ShouldContain("declared size");
        (await LoadMediumAsync(audioId))!.UploadStatus.ShouldBe(MediaUploadStatus.Failed);
        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldBeNull();
    }

    [Fact]
    public async Task Pending_and_failed_are_reported_separately_in_one_answer()
    {
        var entryId = await GivenEntryAsync();
        var lateId = Guid.NewGuid();
        var wrongId = Guid.NewGuid();
        var goodId = Guid.NewGuid();
        await GivenMediaAsync(
            entryId, Wire.Photo(lateId), Wire.Photo(wrongId), Wire.Audio(goodId));

        var media = (await LoadMediaAsync(entryId)).ToDictionary(m => m.Id);
        Storage.PutObject(media[wrongId].ObjectKey, media[wrongId].ByteSize + 10);
        Storage.PutObject(media[goodId].ObjectKey, media[goodId].ByteSize);

        var body = await (await CompleteAsync(entryId)).JsonAsync();

        body.GetProperty("ready").GetBoolean().ShouldBeFalse();
        body.GetGuids("pending_media").ShouldBe([lateId]);
        body.GetGuids("failed_media").ShouldBe([wrongId]);
        body.GetText("reason").ShouldContain("1 file(s) have not arrived");
        body.GetText("reason").ShouldContain("1 file(s) do not match");
    }

    [Fact]
    public async Task A_late_file_that_arrives_lets_a_second_complete_succeed()
    {
        var entryId = await GivenEntryAsync();
        var photoId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Photo(photoId));

        (await (await CompleteAsync(entryId)).JsonAsync())
            .GetProperty("ready").GetBoolean().ShouldBeFalse();

        await GivenUploadsFinishedAsync(entryId);

        (await (await CompleteAsync(entryId)).JsonAsync())
            .GetProperty("ready").GetBoolean().ShouldBeTrue();
        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task A_completed_entry_is_never_re_verified()
    {
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));
        await GivenUploadsFinishedAsync(entryId);

        await CompleteAsync(entryId);
        var receivedAt = (await LoadEntryAsync(entryId))!.ReceivedAt;
        var headsSoFar = Storage.HeadCallCount;

        // Storage now goes dark. A replay must still answer from the record, because re-opening
        // a settled verdict on a temporary outage would un-receive a certified entry.
        Storage.Unreachable = true;
        var replay = await CompleteAsync(entryId);

        replay.StatusCode.ShouldBe(HttpStatusCode.OK);
        Storage.HeadCallCount.ShouldBe(headsSoFar);
        var body = await replay.JsonAsync();
        body.GetProperty("ready").GetBoolean().ShouldBeTrue();
        body.GetProperty("entry").GetProperty("received_at").GetDateTimeOffset()
            .ShouldBe(new DateTimeOffset(DateTime.SpecifyKind(receivedAt!.Value, DateTimeKind.Utc)));

        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldBe(receivedAt);
    }

    [Fact]
    public async Task An_entry_the_pipeline_has_taken_still_answers_ready_from_its_receipt()
    {
        // Sealed by receipt, then advanced by the pipeline — the shape B4 produces. A replay of
        // /complete must answer from the record: ready, no re-verification, receipt unchanged.
        var entryId = Guid.NewGuid();
        var receivedAt = DateTime.UtcNow.AddMinutes(-3);
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            EntryStatus.Processing, receivedAt: receivedAt));
        var headsSoFar = Storage.HeadCallCount;

        var response = await CompleteAsync(entryId);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.JsonAsync()).GetProperty("ready").GetBoolean().ShouldBeTrue();
        Storage.HeadCallCount.ShouldBe(headsSoFar);
        (await LoadEntryAsync(entryId))!.ReceivedAt!.Value
            .ShouldBe(receivedAt, TimeSpan.FromMilliseconds(1));
    }

    [Fact]
    public async Task An_advanced_status_without_a_receipt_is_refused_not_reported_ready()
    {
        // Unreachable through the API as it stands — only entry creation writes status, and only
        // a successful /complete stamps received_at — so this row is arranged directly in the
        // database. It is exactly the state B4 must never create: its pickup predicate is
        // `status = received AND received_at IS NOT NULL` (ARCHITECTURE §6), and an entry that
        // is past `received` with no receipt is a broken row, not a completed one. Answering
        // `ready: true` here (as a single combined early return does) would certify an entry the
        // server has no record of receiving.
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1, EntryStatus.Processing));
        var headsSoFar = Storage.HeadCallCount;

        var response = await CompleteAsync(entryId);

        response.StatusCode.ShouldBe(HttpStatusCode.InternalServerError);
        response.StatusCode.ShouldNotBe(HttpStatusCode.OK);

        // And nothing was papered over on the way out: no receipt invented, no storage consulted.
        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldBeNull();
        Storage.HeadCallCount.ShouldBe(headsSoFar);
    }

    [Fact]
    public async Task A_completed_entrys_evidence_set_is_sealed_against_further_media()
    {
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));
        await GivenUploadsFinishedAsync(entryId);
        await CompleteAsync(entryId);

        var late = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(Wire.Photo(Guid.NewGuid())));

        late.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await late.ProblemDetailAsync()).ShouldContain("sealed");
        (await LoadMediaAsync(entryId)).Count.ShouldBe(1);
    }

    [Fact]
    public async Task Unreachable_storage_is_503_with_a_retry_after_and_no_verdict_is_written()
    {
        // The property that matters is not the status code: it is that a storage outage leaves
        // every media row exactly as it was. A partially-applied verification pass would write
        // "verified" on the objects it managed to check and leave the entry in a state no retry
        // reproduces.
        var entryId = await GivenEntryAsync();
        var firstId = Guid.NewGuid();
        var secondId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(firstId), Wire.Photo(secondId));
        await GivenUploadsFinishedAsync(entryId);

        // The first object answers normally; the second one is where storage falls over, so the
        // handler has already mutated one tracked entity by the time it throws.
        var second = (await LoadMediaAsync(entryId)).Single(m => m.Id == secondId);
        Storage.UnreachableKeys.Add(second.ObjectKey);

        var response = await CompleteAsync(entryId);

        response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
        response.Headers.RetryAfter!.Delta!.Value.ShouldBeGreaterThan(TimeSpan.Zero);
        (await response.TextAsync()).ShouldNotContain("storage.invalid");

        (await LoadMediaAsync(entryId))
            .ShouldAllBe(m => m.UploadStatus == MediaUploadStatus.Pending);
        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldBeNull();
    }

    [Fact]
    public async Task A_storage_outage_is_recoverable_the_moment_storage_comes_back()
    {
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));
        await GivenUploadsFinishedAsync(entryId);
        Storage.Unreachable = true;

        (await CompleteAsync(entryId)).StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);

        Storage.Unreachable = false;
        var recovered = await CompleteAsync(entryId);

        recovered.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await recovered.JsonAsync()).GetProperty("ready").GetBoolean().ShouldBeTrue();
    }

    [Fact]
    public async Task Storage_that_answers_too_slowly_runs_out_of_budget_and_writes_nothing()
    {
        // Storage:VerificationBudget caps the whole pass, not each call — the failure mode a
        // per-call timeout alone does not fix. The fixture sets it to two seconds.
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));
        await GivenUploadsFinishedAsync(entryId);
        Storage.HeadDelay = TimeSpan.FromSeconds(30);

        var started = DateTimeOffset.UtcNow;
        var response = await CompleteAsync(entryId);
        var elapsed = DateTimeOffset.UtcNow - started;

        response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
        elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(20));
        (await LoadMediaAsync(entryId))
            .ShouldAllBe(m => m.UploadStatus == MediaUploadStatus.Pending);
        (await LoadEntryAsync(entryId))!.ReceivedAt.ShouldBeNull();
    }

    [Fact]
    public async Task Completing_an_entry_that_does_not_exist_is_404()
    {
        var response = await CompleteAsync(Guid.NewGuid());

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_path_id_that_is_not_a_uuid_is_400_on_every_entry_route()
    {
        (await Client.PostNothing("/api/entries/not-a-uuid/complete")).StatusCode
            .ShouldBe(HttpStatusCode.BadRequest);
        (await Client.PostJson("/api/entries/not-a-uuid/media",
                Wire.Files(Wire.Audio(Guid.NewGuid())))).StatusCode
            .ShouldBe(HttpStatusCode.BadRequest);
        (await Client.Get("/api/entries/not-a-uuid")).StatusCode
            .ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Completion_stamps_received_at_and_leaves_the_status_at_received()
    {
        // B4's pickup predicate is `status = received AND received_at IS NOT NULL`
        // (ARCHITECTURE §6). Advancing the status here would take the entry out from under it.
        var entryId = await GivenEntryAsync();
        await GivenUploadsFinishedAsync(entryId);

        await CompleteAsync(entryId);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.Received);
        entry.ReceivedAt.ShouldNotBeNull();
        entry.ReceivedAt!.Value.ShouldBeGreaterThan(DateTime.UtcNow.AddMinutes(-5));
    }
}
