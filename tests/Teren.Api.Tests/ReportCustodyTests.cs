using System.Net;
using System.Text.Json.Nodes;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The increment's headline promise, pushed on from the two directions B6's review found it open:
/// <b>a client never receives two reports, and a sealed entry matches the document that was
/// sent.</b>
/// <para>
/// Both holes were compositions rather than single mistakes. The report row's claim, the sweeper's
/// refusal to re-send, and <c>/confirm</c>'s "confirming means report this" each defend themselves
/// perfectly; put together, a phone retrying an HTTP call over a bad link could resend a report
/// whose fate nobody knew, and a foreman correcting his own typo could seal an entry that does not
/// match the PDF his client is reading.
/// </para>
/// </summary>
public sealed class ReportCustodyTests(TerenTestApp app) : ApiTestBase(app)
{
    private FakeReportDelivery Delivery => App.Delivery;

    private RecordingReportRenderer Renderer => App.Renderer;

    // ================================================================ custody unknown

    /// <summary>
    /// A confirmed entry whose report was claimed and abandoned mid-send, then swept — the state
    /// ARCHITECTURE §6 calls <c>report_interrupted</c>: the relay may or may not have the message
    /// and the server cannot tell.
    /// </summary>
    private async Task<Guid> GivenInterruptedReportAsync()
    {
        var entryId = await GivenConfirmedEntryAsync();
        var entry = (await LoadEntryAsync(entryId))!;

        var reportId = Guid.CreateVersion7();
        await InsertReportAsync(new Report
        {
            Id = reportId,
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

        // Older than Reporting:StaleAfter — the worker is not coming back — and swept by the real
        // sweeper rather than by writing the reason in by hand.
        await SetReportAttemptStartedAsync(reportId, DateTime.UtcNow.AddHours(-2));
        (await SweepAsync()).ReportsFailed.ShouldBe(1);

        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.ReportInterrupted, "the arrange did not reach custody-unknown");

        App.Pipeline.Reset();
        Delivery.Reset();
        Renderer.Reset();

        return entryId;
    }

    [Fact]
    public async Task A_phone_replaying_its_confirmation_never_resends_a_report_nobody_can_account_for()
    {
        // The scenario, end to end: a foreman confirms in a basement, the response never reaches
        // his phone, the pass dies mid-SMTP, the sweeper records that nobody knows whether the
        // relay took it — and forty minutes later his phone retries the identical request. That
        // retry is a wire event with no human intent in it, and ARCHITECTURE §6 says a report
        // abandoned mid-send is never re-sent automatically: a person decides.
        var entryId = await GivenInterruptedReportAsync();

        var response = await ConfirmAsync(entryId, DefaultCorrected());
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        App.Pipeline.Reports.ShouldBeEmpty("a replayed confirmation must not queue a resend");

        var entry = (await LoadEntryAsync(entryId))!;
        ReportFailure.CodeOf(entry.FailureReason).ShouldBe(
            ReportFailure.ReportInterrupted,
            "clearing the reason would hand the entry straight back to the sweeper");
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull();

        Delivery.Sent.ShouldBeEmpty();
    }

    [Fact]
    public async Task Even_a_pass_that_does_run_refuses_to_resend_a_report_nobody_can_account_for()
    {
        // Defence in depth, and the guard that actually holds the promise: whatever put the job
        // on the queue — a lost enqueue swept up, a hand-run job, a future resend gesture wired
        // carelessly — the pass itself will not send a report whose predecessor's fate is unknown.
        var entryId = await GivenInterruptedReportAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.Sent.ShouldBeEmpty();
        Delivery.AttemptCount.ShouldBe(0, "the relay was never called");
        Renderer.RenderCount.ShouldBe(0, "and nothing was even rendered for it");

        var report = (await LoadReportAsync(entryId))!;
        report.Status.ShouldBe(ReportStatus.Failed);
        ReportFailure.CodeOf(report.FailureReason).ShouldBe(ReportFailure.ReportInterrupted);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull();
        ReportFailure.CodeOf(entry.FailureReason).ShouldBe(
            ReportFailure.ReportInterrupted,
            "the reason is put back so the entry stops visibly instead of looping");
    }

    [Fact]
    public async Task A_changed_re_confirmation_cannot_launder_an_unaccountable_report_into_a_resend()
    {
        // The way round the replay guard, if the guard were only about byte-identical payloads:
        // change one character and confirm again. That clears the entry's reason at the endpoint
        // — which is right, the human did decide something — but the pass still refuses, because
        // the question "does the client already have a report for this day" is not answered by
        // the foreman editing his notes.
        var entryId = await GivenInterruptedReportAsync();

        var revised = DefaultCorrected();
        revised["notes"] = "Ispravka: nastavak je na drugom spratu.";

        (await ConfirmAsync(entryId, revised)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.Sent.ShouldBeEmpty();
        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.ReportInterrupted);
    }

    // ================================================================ post-DATA failures

    [Fact]
    public async Task A_relay_that_took_the_message_and_then_broke_is_never_tried_again()
    {
        // The classic duplicate-email vector, now representable: the relay accepted the message
        // and the conversation died before it could say so — a content scanner slower than the
        // conversation budget, or a reset after acceptance. Retrying resolves the ambiguity in
        // the client's inbox, at up to Pipeline:MaxAttempts copies of the same site diary.
        var entryId = await GivenConfirmedEntryAsync();

        Delivery.FailsAfterAccepting = () => new ReportDeliveryException(
            "fake-smtp",
            "the relay stopped answering after the message had begun transmitting",
            ReportDeliveryFailureKind.CustodyUnknown);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.AttemptCount.ShouldBe(1, "an ambiguous failure after transmission is not retried");
        Delivery.Sent.Count.ShouldBe(1, "and exactly one copy is out there, not three");

        var report = (await LoadReportAsync(entryId))!;
        report.Status.ShouldBe(ReportStatus.Failed);
        report.SentAt.ShouldBeNull("the relay never confirmed, so nothing may claim it did");
        ReportFailure.CodeOf(report.FailureReason).ShouldBe(
            ReportFailure.DeliveryCustodyUnknown,
            "delivery_failed would mean nothing left the building, which is not what happened");

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull("nothing seals an entry on the strength of a maybe");
        ReportFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ReportFailure.DeliveryCustodyUnknown);
    }

    [Fact]
    public async Task A_report_the_relay_may_already_hold_is_not_resent_by_a_replayed_confirmation()
    {
        // G1 and G1b composed, which is how the original hole was built in the first place: the
        // post-DATA failure leaves custody unknown, and the phone's retry must not resolve it.
        var entryId = await GivenConfirmedEntryAsync();

        Delivery.FailsAfterAccepting = () => new ReportDeliveryException(
            "fake-smtp", "reset after DATA", ReportDeliveryFailureKind.CustodyUnknown);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);
        Delivery.Sent.Count.ShouldBe(1);

        // The relay is healthy again, and the phone retries the same confirmation.
        Delivery.FailsAfterAccepting = null;
        App.Pipeline.Reset();

        (await ConfirmAsync(entryId, DefaultCorrected())).StatusCode.ShouldBe(HttpStatusCode.OK);

        App.Pipeline.Reports.ShouldBeEmpty();
        (await SweepAsync()).ReportsQueued.ShouldBe(0, "and the sweeper does not pick it up either");

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);
        Delivery.Sent.Count.ShouldBe(1, "the client must not receive a second copy of his day");
    }

    // ================================================================ what was sealed is what was sent

    [Fact]
    public async Task A_changed_confirmation_is_refused_while_the_report_is_being_sent()
    {
        // "A person can revise his own answer up until the report goes out" is only true if
        // "until" is enforced. A report row in `sending` is exactly "going out": a pass holds the
        // claim and the next thing it does is hand the PDF to a relay.
        var entryId = await GivenConfirmedEntryAsync();
        var entry = (await LoadEntryAsync(entryId))!;
        var before = entry.Corrected;

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

        var revised = DefaultCorrected();
        revised["notes"] = "Ipak je bilo četvoro ljudi.";

        var response = await ConfirmAsync(entryId, revised);

        response.StatusCode.ShouldBe(
            HttpStatusCode.Conflict,
            "sealing this would leave the archive contradicting the report the client received");

        (await LoadEntryAsync(entryId))!.Corrected.ShouldBe(before, "and nothing was written");
    }

    [Fact]
    public async Task An_unchanged_replay_is_still_free_while_the_report_is_being_sent()
    {
        // The refusal above is narrow on purpose. A phone retrying the same confirmation changes
        // nothing about the entry, so it must not be told to come back later — that is the
        // ordinary lossy-link case, not a revision.
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
            Status = ReportStatus.Sending,
            Attempts = 1,
            AttemptStartedAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow,
        });

        (await ConfirmAsync(entryId, DefaultCorrected())).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_pass_whose_entry_changed_under_it_sends_nothing_and_hands_the_claim_back()
    {
        // The half the endpoint cannot cover, and the longer half: the refusal above needs a
        // `sending` row to see, and the row is created as late as possible — after the evidence
        // is gathered, verified and laid out, which is up to Reporting:RenderBudget of wall clock.
        // A foreman who spots his mistake twenty seconds after confirming lands squarely in it.
        //
        // Sending now would put v1 in the client's inbox and seal v2 in the archive. Instead the
        // claim goes back and the confirmation's own pass reports the new content.
        var entryId = await GivenConfirmedEntryAsync();

        var revised = DefaultCorrected();
        revised["notes"] = "Ispravka: sutra se ne radi, praznik je.";

        Renderer.WhileRendering = () =>
        {
            Renderer.WhileRendering = null;
            ConfirmAsync(entryId, revised).GetAwaiter().GetResult()
                .StatusCode.ShouldBe(
                    HttpStatusCode.OK,
                    "no claim exists yet, so this revision is legitimately accepted");
        };

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Skipped);

        Renderer.RenderCount.ShouldBe(1, "this pass rendered, then threw the result away");
        Delivery.Sent.ShouldBeEmpty("a document that no longer matches the entry is not sent");

        var report = (await LoadReportAsync(entryId))!;
        report.Status.ShouldBe(ReportStatus.Failed);
        report.SentAt.ShouldBeNull();
        ReportFailure.CodeOf(report.FailureReason).ShouldBe(ReportFailure.Superseded);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull();
        entry.FailureReason.ShouldBeNull(
            "nothing went wrong that a person must see, and a clean entry keeps the sweeper "
            + "covering the replacement");

        // And the replacement really does go out — carrying the corrected content, not the
        // document that was rendered first.
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        Delivery.Sent.Count.ShouldBe(1);
        Renderer.LastRendered!.Content.Notes.ShouldBe("Ispravka: sutra se ne radi, praznik je.");

        var sealedEntry = (await LoadEntryAsync(entryId))!;
        sealedEntry.Status.ShouldBe(EntryStatus.Reported);
        JsonNode.Parse(sealedEntry.Corrected!)!["notes"]!.GetValue<string>()
            .ShouldBe(
                "Ispravka: sutra se ne radi, praznik je.",
                "what was sealed is what was sent");
    }

    [Fact]
    public async Task A_superseded_claim_is_reclaimable_where_an_unaccountable_one_is_not()
    {
        // The distinction the release depends on. `superseded` means nothing left the building
        // and a newer confirmation exists, so the row must be reclaimable and the entry must stay
        // clean enough for the sweeper to cover a lost enqueue. That is the opposite of a
        // custody-unknown row, which no automatic path may pick up again.
        var entryId = await GivenConfirmedEntryAsync();

        var revised = DefaultCorrected();
        revised["notes"] = "Druga verzija.";

        Renderer.WhileRendering = () =>
        {
            Renderer.WhileRendering = null;
            ConfirmAsync(entryId, revised).GetAwaiter().GetResult();
        };

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Skipped);

        App.Pipeline.Reset();
        (await SweepAsync()).ReportsQueued.ShouldBe(
            1, "a released claim leaves work the sweeper is meant to find");
        App.Pipeline.Reports.ShouldContain((entryId, TestIds.CompanyA));
    }
}
