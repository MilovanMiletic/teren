using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Reporting;
using Teren.Core.Storage;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// ROADMAP B6 — a confirmed entry produces a PDF in the project's language that lands in a real
/// inbox.
/// <para>
/// Four invariants carry the increment, and each has a test here whose failure is the point:
/// the report language follows the **project** and not the caller; a photograph whose SHA-256
/// does not match what the phone declared is never embedded; <c>reported_at</c> is stamped only
/// after the document exists and a relay has accepted it, and seals the entry forever; and a
/// pass that no longer owns its claim writes nothing.
/// </para>
/// </summary>
public sealed class ReportGenerationTests(TerenTestApp app) : ApiTestBase(app)
{
    private FakeReportDelivery Delivery => App.Delivery;

    private RecordingReportRenderer Renderer => App.Renderer;

    // ---------------------------------------------------------------- the happy path

    [Fact]
    public async Task A_confirmed_entry_produces_a_stored_pdf_a_sent_report_and_a_sealed_entry()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 2);

        var outcome = await ReportAsync(entryId);

        outcome.ShouldBe(ReportOutcome.Sent);

        // 1. the document exists, in storage, as a PDF, at the key derived from the entry
        var entry = (await LoadEntryAsync(entryId))!;
        var key = ObjectKeys.ForEntryReport(entry.CompanyId, entry.ProjectId, entry.Id);

        var stored = Storage.GetObject(key).ShouldNotBeNull();
        Encoding.ASCII.GetString(stored, 0, 5).ShouldBe("%PDF-");
        Storage.ContentTypeOf(key).ShouldBe("application/pdf");

        // 2. it reached the relay, with the PDF attached
        Delivery.Sent.Count.ShouldBe(1);
        var message = Delivery.LastSent.ShouldNotBeNull();
        message.Attachment.ShouldBe(stored);
        message.AttachmentContentType.ShouldBe("application/pdf");
        message.AttachmentFileName.ShouldEndWith(".pdf");

        // 3. the report row records what happened, honestly
        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        report.Status.ShouldBe(ReportStatus.Sent);
        report.SentAt.ShouldNotBeNull();
        report.PdfObjectKey.ShouldBe(key);
        report.Kind.ShouldBe(ReportKind.Daily);
        report.PeriodStart.ShouldBe(entry.EntryDate);
        report.PeriodEnd.ShouldBe(entry.EntryDate);
        report.Attempts.ShouldBe(1);
        report.AttemptStartedAt.ShouldBeNull();
        report.FailureReason.ShouldBeNull();
        // What the relay actually said, kept on the row: it is the strongest claim this system
        // can honestly make about a report, and it is not "delivered".
        report.DeliveryDetail.ShouldBe(Delivery.RelayResponse);

        // 4. the entry is sealed
        entry.Status.ShouldBe(EntryStatus.Reported);
        entry.ReportedAt.ShouldNotBeNull();
        entry.FailureReason.ShouldBeNull();
    }

    [Fact]
    public async Task The_report_carries_the_entrys_own_evidence_into_the_document()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 3);

        await ReportAsync(entryId);

        var model = Renderer.LastRendered.ShouldNotBeNull();

        model.Provenance.EntryId.ShouldBe(entryId);
        model.CompanyName.ShouldBe(TestIds.CompanyAName);
        model.ProjectName.ShouldBe("Stambena zgrada Vojvode Stepe 212");

        // The photographs on the page are this entry's media, in order, each carrying the
        // checksum that was verified rather than a value copied from the request.
        var media = (await LoadMediaAsync(entryId))
            .Where(m => m.Kind == MediaKind.Photo)
            .OrderBy(m => m.CapturedAt ?? m.CreatedAt)
            .ThenBy(m => m.Id)
            .ToList();

        model.Photos.Select(p => p.MediaId).ShouldBe(media.Select(m => m.Id));
        model.Photos.Select(p => p.Sha256).ShouldBe(media.Select(m => m.Sha256.TrimEnd()));

        // The audio is evidence too, but it is not something a client reads: only photographs go
        // on the page.
        model.Photos.Count.ShouldBe(3);
    }

    [Fact]
    public async Task What_the_human_approved_is_what_the_client_reads()
    {
        // The model's answer and the human's answer are different columns (§9.3), and only one
        // of them may reach a client: the one a person put his name to.
        var corrected = DefaultCorrected();
        corrected["notes"] = "Ispravljeno rukom pre slanja";

        var entryId = await GivenConfirmedEntryAsync(corrected: corrected);

        await ReportAsync(entryId);

        Renderer.LastRendered.ShouldNotBeNull()
            .Content.Notes.ShouldBe("Ispravljeno rukom pre slanja");
    }

    // ---------------------------------------------------------------- the language rule

    [Fact]
    public async Task The_report_language_follows_the_project_not_the_caller()
    {
        // Two entries, same device, same company, same request — and two different languages,
        // because the language belongs to the client the report is for. Project A2 is the
        // foreign investor's site (report_language 'en'); A1 is Serbian.
        var serbianEntry = await GivenConfirmedEntryAsync(projectId: TestIds.ProjectA1);
        var englishEntry = await GivenConfirmedEntryAsync(projectId: TestIds.ProjectA2);

        (await ReportAsync(serbianEntry)).ShouldBe(ReportOutcome.Sent);
        var serbian = Delivery.LastSent.ShouldNotBeNull();

        (await ReportAsync(englishEntry)).ShouldBe(ReportOutcome.Sent);
        var english = Delivery.LastSent.ShouldNotBeNull();

        serbian.Subject.ShouldStartWith("Dnevni izveštaj");
        serbian.BodyText.ShouldContain("Poštovani");
        serbian.AttachmentFileName.ShouldStartWith("Dnevni-izvestaj-");

        english.Subject.ShouldStartWith("Daily site report");
        english.BodyText.ShouldContain("Dear Sir or Madam");
        english.AttachmentFileName.ShouldStartWith("Daily-site-report-");

        // And the same language reaches the document, not only the covering note.
        Renderer.Rendered[0].Language.ShouldBe("sr");
        Renderer.Rendered[1].Language.ShouldBe("en");
    }

    [Fact]
    public async Task An_unrecognised_report_language_falls_back_to_serbian_rather_than_failing()
    {
        // A mistyped column must not stop a client's diary arriving; Serbian is the product's
        // default and the market it is sold in.
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.ReportLanguage = "kl");

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        Delivery.LastSent.ShouldNotBeNull().Subject.ShouldStartWith("Dnevni izveštaj");
    }

    // ---------------------------------------------------------------- the checksum rule

    [Fact]
    public async Task A_photograph_that_does_not_match_its_declared_checksum_stops_the_whole_report()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 2);

        // The bytes in storage are replaced with different bytes of the same length — exactly
        // the case /complete cannot catch, because it verifies existence and size only
        // (ARCHITECTURE §6). This is the moment the promise it deferred has to be kept.
        var photo = (await LoadMediaAsync(entryId)).First(m => m.Kind == MediaKind.Photo);
        var original = Storage.GetObject(photo.ObjectKey).ShouldNotBeNull();
        var tampered = (byte[])original.Clone();
        tampered[^1] ^= 0xFF;
        Storage.PutObject(photo.ObjectKey, tampered);

        var outcome = await ReportAsync(entryId);

        outcome.ShouldBe(ReportOutcome.Failed);

        // Nothing was rendered, nothing was stored, nothing was sent, nothing was claimed.
        Renderer.RenderCount.ShouldBe(0, "a tampered photograph must never reach the renderer");
        Delivery.Sent.ShouldBeEmpty();
        Delivery.AttemptCount.ShouldBe(0);
        (await LoadReportAsync(entryId)).ShouldBeNull();

        // And the entry is not sealed — it is still reportable once the evidence is explained.
        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull();
        ReportFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ReportFailure.PhotoChecksumMismatch);
    }

    [Fact]
    public async Task A_photograph_that_has_vanished_from_storage_stops_the_report()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 2);

        var photo = (await LoadMediaAsync(entryId)).First(m => m.Kind == MediaKind.Photo);
        Storage.RemoveObject(photo.ObjectKey);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.Sent.ShouldBeEmpty();
        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.PhotoMissing);
    }

    [Fact]
    public async Task Unreachable_storage_is_retried_and_then_reported_as_an_outage_not_as_bad_evidence()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 1);

        // The arrange already read the voice note once, during processing.
        var readsBefore = Storage.ReadCallCount;
        Storage.Unreachable = true;

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        // A storage outage says nothing about the bytes, so it must not be recorded as a
        // checksum problem — the entry's evidence is presumed fine and the report is retryable.
        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.StorageUnavailable);

        (Storage.ReadCallCount - readsBefore).ShouldBe(
            3, "a transient storage failure gets Pipeline:MaxAttempts and no more");
    }

    [Fact]
    public async Task A_render_that_outlives_its_budget_sends_nothing_and_stays_reportable()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 3);

        // Storage that answers slowly rather than not at all — the exact failure
        // Reporting:RenderBudget exists for, and the one a per-call timeout alone does not fix.
        Storage.ReadDelay = TimeSpan.FromSeconds(1.2);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.Sent.ShouldBeEmpty();
        (await LoadReportAsync(entryId)).ShouldBeNull();

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        ReportFailure.CodeOf(entry.FailureReason).ShouldBe(ReportFailure.RenderTimeout);
    }

    // ---------------------------------------------------------------- refusals before sending

    [Fact]
    public async Task A_project_with_nobody_on_the_distribution_list_produces_no_report()
    {
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.Recipients = "[]");

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Renderer.RenderCount.ShouldBe(0, "there is no point rendering a report nobody receives");
        Delivery.Sent.ShouldBeEmpty();
        (await LoadReportAsync(entryId)).ShouldBeNull();

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull("an entry nobody was sent is not a reported entry");
        ReportFailure.CodeOf(entry.FailureReason).ShouldBe(ReportFailure.NoRecipients);
    }

    [Fact]
    public async Task A_distribution_list_of_nothing_but_typos_produces_no_report()
    {
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.Recipients =
            """[{"name": "Dragan", "email": "dragan.obradovic.example.com", "role": "investitor"}]""");

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.Sent.ShouldBeEmpty();
        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.RecipientsUnusable);
    }

    [Fact]
    public async Task With_no_relay_configured_the_entry_stops_visibly_rather_than_the_host_refusing_to_run()
    {
        Delivery.Configured = false;

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        // Checked before anything is rendered: a PDF nobody can send is work for nothing.
        Renderer.RenderCount.ShouldBe(0);
        Delivery.AttemptCount.ShouldBe(0);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        ReportFailure.CodeOf(entry.FailureReason)
            .ShouldBe(ReportFailure.DeliveryNotConfigured);
    }

    [Fact]
    public async Task An_entry_with_nothing_in_it_never_becomes_an_empty_report()
    {
        // An empty page with a letterhead tells the client the day was documented when it was
        // not. Same refusal the pipeline makes for `no_evidence`.
        var entryId = await GivenConfirmedEntryAsync(
            corrected: new JsonObject { ["schema_version"] = 1 });

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.Sent.ShouldBeEmpty();
        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.NothingToReport);
    }

    [Fact]
    public async Task An_entry_whose_only_content_is_photographs_is_still_worth_reporting()
    {
        // The other side of the rule above, and the case that matters most commercially: hidden
        // work photographed before the wall closes, with an extraction that found no words.
        var entryId = await GivenConfirmedEntryAsync(
            photos: 2, corrected: new JsonObject { ["schema_version"] = 1 });

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        Delivery.Sent.Count.ShouldBe(1);
    }

    [Fact]
    public async Task A_document_that_cannot_be_laid_out_stops_before_anything_is_claimed()
    {
        Renderer.Fails = () => new InvalidOperationException("the layout is impossible");

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        Delivery.Sent.ShouldBeEmpty();
        (await LoadReportAsync(entryId)).ShouldBeNull();
        ReportFailure.CodeOf((await LoadEntryAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.RenderFailed);
    }

    // ---------------------------------------------------------------- what is reportable

    [Theory]
    [InlineData(EntryStatus.Received)]
    [InlineData(EntryStatus.Processing)]
    [InlineData(EntryStatus.AwaitingConfirmation)]
    [InlineData(EntryStatus.NeedsReview)]
    public async Task Only_a_confirmed_entry_is_ever_reported(EntryStatus status)
    {
        // The confirmation screen is mandatory before any report is sent (PROJECT.md principle
        // 5). Nothing else is reportable, ever — least of all an entry still awaiting the human.
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1, status,
            receivedAt: DateTime.UtcNow));

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Skipped);

        Delivery.Sent.ShouldBeEmpty();
        Renderer.RenderCount.ShouldBe(0);
        (await LoadEntryAsync(entryId))!.ReportedAt.ShouldBeNull();
    }

    [Fact]
    public async Task Another_companys_entry_is_invisible_to_a_report_pass()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyB, TestIds.ProjectB1, EntryStatus.Confirmed,
            receivedAt: DateTime.UtcNow));

        // The job is handed company A, as a job whose queue argument was wrong or stale would be.
        (await ReportAsync(entryId, TestIds.CompanyA)).ShouldBe(ReportOutcome.Skipped);

        Delivery.Sent.ShouldBeEmpty();
        (await LoadEntryAsync(entryId, TestIds.CompanyB))!.ReportedAt.ShouldBeNull();
    }

    // ---------------------------------------------------------------- sealing

    [Fact]
    public async Task A_reported_entry_is_immutable_and_undeletable_afterwards()
    {
        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.ReportedAt.ShouldNotBeNull();

        // The application half of the promise: /confirm refuses to touch it.
        var confirm = await ConfirmAsync(entryId, DefaultCorrected());
        confirm.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await confirm.ProblemDetailAsync()).ShouldContain("supersedes_entry_id");

        // The half that holds against any SQL: the Postgres trigger from the initial migration.
        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var refused = await Should.ThrowAsync<Exception>(async () =>
            await db.Entries
                .Where(e => e.Id == entryId)
                .ExecuteUpdateAsync(s => s.SetProperty(e => e.Weather, "{}"), Ct));

        refused.ToString().ShouldContain("immutable");
    }

    [Fact]
    public async Task Nothing_stamps_reported_at_before_the_document_exists_and_a_relay_has_taken_it()
    {
        // The stamp is irreversible by design, so the ordering it depends on is worth asserting
        // directly: at the moment the relay is handed the message, the PDF is already in storage
        // and the entry is still unsealed. Only afterwards does reported_at appear.
        var entryId = await GivenConfirmedEntryAsync(photos: 1);

        var entry = (await LoadEntryAsync(entryId))!;
        var key = ObjectKeys.ForEntryReport(entry.CompanyId, entry.ProjectId, entry.Id);

        DateTime? sealedDuringSend = null;
        byte[]? storedDuringSend = null;

        Delivery.WhileSending = async () =>
        {
            storedDuringSend = Storage.GetObject(key);
            sealedDuringSend = (await LoadEntryAsync(entryId))!.ReportedAt;
        };

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        storedDuringSend.ShouldNotBeNull(
            "the PDF must be in storage before the relay is asked to carry it");
        sealedDuringSend.ShouldBeNull(
            "reported_at must not be stamped before delivery has been attempted");

        (await LoadEntryAsync(entryId))!.ReportedAt.ShouldNotBeNull();
    }

    // ---------------------------------------------------------------- losing the claim

    [Fact]
    public async Task A_pass_whose_claim_was_taken_while_it_was_sending_records_nothing_and_seals_nothing()
    {
        // B4's gating bug in its B6 shape: a pass that outlived the stale window came back and
        // wrote over a row it no longer owned. Here the sweeper decides, mid-send, that this
        // pass is abandoned. The relay does accept the message — so the pass may not pretend it
        // did not — but it must not overwrite the row's verdict, and above all it must not seal
        // the entry while its own record of the send is in doubt.
        var entryId = await GivenConfirmedEntryAsync();

        Delivery.WhileSending = async () =>
        {
            var report = (await LoadReportAsync(entryId))!;
            await SetReportAttemptStartedAsync(report.Id, DateTime.UtcNow.AddHours(-2));
            (await SweepAsync()).ReportsFailed.ShouldBe(1);
        };

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var afterwards = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        afterwards.Status.ShouldBe(
            ReportStatus.Failed, "the late pass must not overwrite the verdict on a row it lost");
        afterwards.SentAt.ShouldBeNull();

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull(
            "reported_at is irreversible, so it is never stamped on a doubtful record");
    }

    [Fact]
    public async Task A_failing_pass_whose_entry_was_reported_meanwhile_leaves_the_sealed_entry_alone()
    {
        // The other half of the same rule. This pass is about to record a failure when the entry
        // it is about is reported underneath it. A reported entry is immutable — the Postgres
        // trigger rejects any UPDATE to it — so an unconditional write here would not merely
        // corrupt the row, it would blow up the job.
        var entryId = await GivenConfirmedEntryAsync();

        Delivery.WhileSending = async () =>
        {
            await using var db = App.CreateDbContext(TestIds.CompanyA);
            await db.Entries
                .Where(e => e.Id == entryId && e.ReportedAt == null)
                .ExecuteUpdateAsync(
                    s => s
                        .SetProperty(e => e.Status, EntryStatus.Reported)
                        .SetProperty(e => e.ReportedAt, DateTime.UtcNow),
                    Ct);
        };

        Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "mailbox unavailable", ReportDeliveryFailureKind.Rejected);

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        // The entry is untouched: still reported, still with no failure reason written over it.
        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Reported);
        entry.ReportedAt.ShouldNotBeNull();
        entry.FailureReason.ShouldBeNull();

        // The report row, which this pass does still own, records the truth.
        ReportFailure.CodeOf((await LoadReportAsync(entryId))!.FailureReason)
            .ShouldBe(ReportFailure.DeliveryRejected);
    }

    [Fact]
    public async Task A_failed_delivery_leaves_the_entry_unsealed_and_therefore_still_correctable()
    {
        Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "mailbox unavailable", ReportDeliveryFailureKind.Rejected);

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.ReportedAt.ShouldBeNull(
            "an entry whose report was refused must stay correctable, not be sealed forever");
        entry.Status.ShouldBe(EntryStatus.Confirmed);

        // And it is still editable, which is the whole point of not having sealed it.
        (await ConfirmAsync(entryId, DefaultCorrected())).StatusCode.ShouldBe(HttpStatusCode.OK);
    }
}
