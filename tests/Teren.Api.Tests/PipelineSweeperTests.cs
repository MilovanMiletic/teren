using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Processing;

namespace Teren.Api.Tests;

/// <summary>
/// The safety net under the enqueue path. Two failures it exists to make survivable: an enqueue
/// that never happened, and a worker that never came back.
/// </summary>
public sealed class PipelineSweeperTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task An_entry_whose_enqueue_was_lost_is_found_and_queued()
    {
        // Exactly the shape of "the process died between the commit and the queue write".
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Pipeline.Reset();

        var result = await SweepAsync();

        result.Enqueued.ShouldBe(1);
        App.Pipeline.Enqueued.ShouldHaveSingleItem().ShouldBe((entryId, TestIds.CompanyA));
    }

    [Fact]
    public async Task An_entry_without_a_receipt_is_left_alone()
    {
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));
        App.Pipeline.Reset();

        (await SweepAsync()).Enqueued.ShouldBe(0);
        App.Pipeline.Enqueued.ShouldBeEmpty();
    }

    [Fact]
    public async Task An_entry_already_processed_is_left_alone()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        await ProcessAsync(entryId);
        App.Pipeline.Reset();

        (await SweepAsync()).Enqueued.ShouldBe(0);
    }

    [Fact]
    public async Task The_sweep_finds_work_across_every_company()
    {
        // "Is any company's entry stuck" is a system question, and the sweep is the one place
        // that asks it. Each entry it finds carries its own company id, so the work that follows
        // is tenant-scoped again.
        var mine = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(mine);

        var theirs = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            theirs, TestIds.CompanyB, TestIds.ProjectB1, receivedAt: DateTime.UtcNow));

        App.Pipeline.Reset();
        var result = await SweepAsync();

        result.Enqueued.ShouldBe(2);
        App.Pipeline.Enqueued.ShouldContain((mine, TestIds.CompanyA));
        App.Pipeline.Enqueued.ShouldContain((theirs, TestIds.CompanyB));
    }

    [Fact]
    public async Task An_entry_abandoned_in_processing_is_parked_where_a_human_can_see_it()
    {
        // A restart mid-pass. Without this the entry would sit in `processing` forever, which is
        // data loss wearing a status nobody watches.
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            status: EntryStatus.Processing,
            receivedAt: DateTime.UtcNow.AddHours(-2),
            rawTranscript: "Zavrsili razvod tople i hladne vode."));
        await SetProcessingStartedAsync(entryId, DateTime.UtcNow.AddHours(-1));

        var result = await SweepAsync();

        result.Parked.ShouldBe(1);

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.NeedsReview);
        ProcessingFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ProcessingFailure.ProcessingInterrupted);
        entry.ProcessingStartedAt.ShouldBeNull();
        // Whatever the abandoned pass had produced is still there.
        entry.RawTranscript.ShouldBe("Zavrsili razvod tople i hladne vode.");
    }

    [Fact]
    public async Task An_entry_being_worked_on_right_now_is_not_disturbed()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            status: EntryStatus.Processing, receivedAt: DateTime.UtcNow));
        await SetProcessingStartedAsync(entryId, DateTime.UtcNow);

        (await SweepAsync()).Parked.ShouldBe(0);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.Processing);
    }

    [Fact]
    public async Task A_sweep_with_nothing_to_do_reports_nothing()
    {
        var result = await SweepAsync();

        result.Enqueued.ShouldBe(0);
        result.Parked.ShouldBe(0);
    }
}
