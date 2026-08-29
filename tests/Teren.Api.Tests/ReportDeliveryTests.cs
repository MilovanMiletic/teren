using System.Net;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The relay half of B6: who the report is addressed to, what happens when the relay refuses,
/// and — the one that matters most — that a client never receives the same site report twice.
/// <para>
/// The claim is the <c>report</c> row's unique <c>entry_id</c>, and it is created immediately
/// before the relay call and never before the PDF exists. Everything below is that mechanism
/// being pushed on.
/// </para>
/// </summary>
public sealed class ReportDeliveryTests(TerenTestApp app) : ApiTestBase(app)
{
    private FakeReportDelivery Delivery => App.Delivery;

    private RecordingReportRenderer Renderer => App.Renderer;

    // ---------------------------------------------------------------- addressing

    [Fact]
    public async Task Every_recipient_on_the_project_is_written_to_in_one_message()
    {
        // Commercial jobs in Serbia carry the investor and the nadzorni organ on one
        // distribution list, which is why the demo seed's second site does too. Project A2 is
        // the two-recipient baseline.
        var entryId = await GivenConfirmedEntryAsync(projectId: TestIds.ProjectA2);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var message = Delivery.LastSent.ShouldNotBeNull();
        message.Recipients.Select(r => r.Email).ShouldBe(
            ["jelena.markovic@example.com", "aleksandar.stankovic@example.com"]);
        message.Recipients.Select(r => r.Role).ShouldBe(["investitor", "nadzorni organ"]);

        Delivery.AttemptCount.ShouldBe(
            1, "two recipients are two addresses on one message, not two sends");
    }

    [Fact]
    public async Task Who_it_went_to_is_snapshotted_on_the_report_rather_than_looked_up_later()
    {
        var entryId = await GivenConfirmedEntryAsync(projectId: TestIds.ProjectA2);

        await ReportAsync(entryId);

        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        var snapshot = ProjectRecipients.Read(report.Recipients);

        snapshot.Select(r => r.Email).ShouldBe(
            ["jelena.markovic@example.com", "aleksandar.stankovic@example.com"]);

        // Editing the project's list afterwards must not rewrite who this report went to.
        await UpdateProjectAsync(TestIds.ProjectA2, p => p.Recipients = "[]");

        ProjectRecipients.Read((await LoadReportAsync(entryId))!.Recipients).Count.ShouldBe(2);
    }

    [Fact]
    public async Task An_unusable_address_beside_a_usable_one_does_not_stop_the_report()
    {
        // One typo on a two-name list must not cost the other recipient his diary. The pass
        // writes to whoever it can and says loudly that it dropped one.
        Delivery.UnusableAddresses.Add("aleksandar.stankovic@example.com");

        var entryId = await GivenConfirmedEntryAsync(projectId: TestIds.ProjectA2);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var message = Delivery.LastSent.ShouldNotBeNull();
        message.Recipients.Select(r => r.Email).ShouldBe(["jelena.markovic@example.com"]);

        // And the snapshot records who was actually written to, not who was on the project.
        ProjectRecipients.Read((await LoadReportAsync(entryId))!.Recipients).Count.ShouldBe(1);
    }

    // ---------------------------------------------------------------- retry policy

    [Fact]
    public async Task A_relay_that_declines_for_now_is_retried_within_the_pass()
    {
        Delivery.FailFirstAttempts = 2;

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        Delivery.AttemptCount.ShouldBe(3, "Pipeline:MaxAttempts, counting the first");
        Delivery.Sent.Count.ShouldBe(1, "a retried send is still one report");
        Renderer.RenderCount.ShouldBe(1, "a delivery retry must not re-render the document");
    }

    [Fact]
    public async Task A_relay_that_keeps_declining_gives_up_visibly_rather_than_forever()
    {
        Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "connection reset", ReportDeliveryFailureKind.Transient);

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.AttemptCount.ShouldBe(3);

        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        report.Status.ShouldBe(ReportStatus.Failed);
        report.SentAt.ShouldBeNull();
        report.AttemptStartedAt.ShouldBeNull();
        ReportFailure.CodeOf(report.FailureReason).ShouldBe(ReportFailure.DeliveryFailed);

        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.DeliveryFailed);
    }

    [Theory]
    [InlineData(ReportDeliveryFailureKind.Rejected, ReportFailure.DeliveryRejected)]
    [InlineData(ReportDeliveryFailureKind.Unauthorized, ReportFailure.DeliveryUnauthorized)]
    public async Task A_permanent_refusal_is_not_retried_and_keeps_its_own_code(
        ReportDeliveryFailureKind kind, string expectedCode)
    {
        // Classified on the typed kind, never on the relay's English banner — the same
        // discipline B3's upload taxonomy and B4's provider failures follow. A rejected address
        // and a rejected password are different problems and a person must be told which.
        Delivery.Fails = () => new ReportDeliveryException("fake-smtp", "refused", kind);

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.AttemptCount.ShouldBe(
            1, "repeating a permanent refusal only delays the honest answer");

        ReportFailure.CodeOf((await LoadReportAsync(entryId))!.FailureReason)
            .ShouldBe(expectedCode);
    }

    // ---------------------------------------------------------------- never twice

    [Fact]
    public async Task Reporting_the_same_entry_again_sends_nothing()
    {
        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Skipped);

        Delivery.Sent.Count.ShouldBe(1, "a client must never receive the same report twice");
        Renderer.RenderCount.ShouldBe(1);
    }

    [Fact]
    public async Task A_pass_that_finds_the_claim_already_taken_sends_nothing()
    {
        var entryId = await GivenConfirmedEntryAsync();
        var entry = (await LoadEntryAsync(entryId))!;

        // Another worker is mid-send: the row exists, in `sending`, with the claim held.
        await InsertReportAsync(new Report
        {
            Id = Guid.CreateVersion7(),
            CompanyId = entry.CompanyId,
            ProjectId = entry.ProjectId,
            EntryId = entryId,
            Kind = ReportKind.Daily,
            PeriodStart = entry.EntryDate,
            PeriodEnd = entry.EntryDate,
            Status = ReportStatus.Sending,
            Attempts = 1,
            AttemptStartedAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow,
        });

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Skipped);

        Delivery.Sent.ShouldBeEmpty();
        Renderer.RenderCount.ShouldBe(0);
        (await LoadEntryAsync(entryId))!.ReportedAt.ShouldBeNull();
    }

    [Fact]
    public async Task A_pass_that_loses_the_claim_race_after_rendering_still_sends_nothing()
    {
        // The narrow window the unique index exists for: two passes both get as far as a
        // finished PDF, and the insert decides. The loser must waste a render, not put a second
        // copy of a site diary in an investor's inbox.
        var entryId = await GivenConfirmedEntryAsync();
        var entry = (await LoadEntryAsync(entryId))!;
        var competitor = Guid.CreateVersion7();

        // The competitor's claim appears while this pass is laying the document out — the last
        // moment before it tries to take the claim for itself.
        Renderer.WhileRendering = () => InsertReportAsync(new Report
        {
            Id = competitor,
            CompanyId = entry.CompanyId,
            ProjectId = entry.ProjectId,
            EntryId = entryId,
            Kind = ReportKind.Daily,
            PeriodStart = entry.EntryDate,
            PeriodEnd = entry.EntryDate,
            Status = ReportStatus.Sending,
            Attempts = 1,
            AttemptStartedAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow,
        }).GetAwaiter().GetResult();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Skipped);

        Renderer.RenderCount.ShouldBe(1, "this pass did render — and then threw the result away");
        Delivery.Sent.ShouldBeEmpty();
        (await LoadReportAsync(entryId))!.Id.ShouldBe(competitor);
        (await LoadEntryAsync(entryId))!.ReportedAt.ShouldBeNull();
    }

    [Fact]
    public async Task A_report_the_relay_took_but_that_was_never_sealed_is_finished_not_resent()
    {
        // The crash window: the process died between "the relay said 250" and "the entry is
        // sealed". Sending again would put a second copy in a client's inbox; the pass finishes
        // the job it can prove was done.
        var entryId = await GivenConfirmedEntryAsync();
        var entry = (await LoadEntryAsync(entryId))!;

        await InsertReportAsync(new Report
        {
            Id = Guid.CreateVersion7(),
            CompanyId = entry.CompanyId,
            ProjectId = entry.ProjectId,
            EntryId = entryId,
            Kind = ReportKind.Daily,
            PeriodStart = entry.EntryDate,
            PeriodEnd = entry.EntryDate,
            Status = ReportStatus.Sent,
            SentAt = DateTime.UtcNow,
            Attempts = 1,
            CreatedAt = DateTime.UtcNow,
        });

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        Delivery.Sent.ShouldBeEmpty("the relay already has this report");
        Renderer.RenderCount.ShouldBe(0);

        var sealedEntry = (await LoadEntryAsync(entryId))!;
        sealedEntry.Status.ShouldBe(EntryStatus.Reported);
        sealedEntry.ReportedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task A_failed_report_is_picked_up_again_and_counted_as_a_second_attempt()
    {
        Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "greylisted", ReportDeliveryFailureKind.Rejected);

        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        // The founder fixes the address and the entry is confirmed again, which is the retry
        // path: /confirm clears failure_reason and re-queues.
        Delivery.Fails = null;
        (await ConfirmAsync(entryId, DefaultCorrected())).StatusCode.ShouldBe(HttpStatusCode.OK);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        report.Status.ShouldBe(ReportStatus.Sent);
        report.Attempts.ShouldBe(2, "the same report row is reused, not duplicated");
        report.FailureReason.ShouldBeNull();

        Delivery.Sent.Count.ShouldBe(1);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.Reported);
    }

    [Fact]
    public async Task A_retry_overwrites_its_own_pdf_rather_than_stranding_an_orphan()
    {
        Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "greylisted", ReportDeliveryFailureKind.Transient);

        var entryId = await GivenConfirmedEntryAsync(photos: 1);
        await ReportAsync(entryId);

        Delivery.Fails = null;
        await ConfirmAsync(entryId, DefaultCorrected());
        await ReportAsync(entryId);

        // The key is derived from the entry, not from a fresh report id, so both passes wrote to
        // the same object: no orphan PDF anybody pays to store and nobody will ever fetch.
        Storage.PutCalls.Distinct().Count().ShouldBe(1);
        Storage.PutCalls.Count.ShouldBe(2);
    }

    // ---------------------------------------------------------------- confirmation enqueues

    [Fact]
    public async Task Re_confirming_an_unchanged_entry_still_queues_the_report_again()
    {
        // The realistic retry, and it must not depend on the foreman editing anything. The
        // report failed because the project had no recipients; the founder adds one; the same
        // entry, byte for byte, is confirmed again. If a replayed confirmation short-circuited,
        // the documented "fix the cause and confirm again" path would do nothing at all and the
        // entry would sit unreported forever.
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.Recipients = "[]");

        var corrected = DefaultCorrected();
        var entryId = await GivenConfirmedEntryAsync(corrected: corrected);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);
        (await LoadEntryAsync(entryId))!.FailureReason.ShouldNotBeNull();

        await UpdateProjectAsync(
            TestIds.ProjectA1, p => p.Recipients = TerenTestApp.OneRecipient);

        App.Pipeline.Reset();
        var confirmedAtBefore = (await LoadEntryAsync(entryId))!.ConfirmedAt;

        (await ConfirmAsync(entryId, corrected)).StatusCode.ShouldBe(HttpStatusCode.OK);

        App.Pipeline.Reports.ShouldBe([(entryId, TestIds.CompanyA)]);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.FailureReason.ShouldBeNull("a stale reason would keep the sweeper away from it");
        entry.ConfirmedAt.ShouldBe(
            confirmedAtBefore,
            "a replay keeps the moment the human decided, not the moment his phone retried");

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);
        Delivery.Sent.Count.ShouldBe(1);
    }

    [Fact]
    public async Task Confirming_queues_the_report_instead_of_building_it_in_the_request()
    {
        // Principle 4 in one assertion: generating a PDF and holding an SMTP conversation open
        // inside a request a human is waiting on is exactly what must not happen.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        await ProcessAsync(entryId);

        App.Pipeline.Reset();

        (await ConfirmAsync(entryId, DefaultCorrected())).StatusCode.ShouldBe(HttpStatusCode.OK);

        App.Pipeline.Reports.ShouldBe([(entryId, TestIds.CompanyA)]);
        Delivery.AttemptCount.ShouldBe(0, "nothing is sent from the request thread");
        Renderer.RenderCount.ShouldBe(0, "nothing is rendered on the request thread");
    }
}
