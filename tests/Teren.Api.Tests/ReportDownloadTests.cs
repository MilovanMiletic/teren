using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Reporting;
using Teren.Core.Storage;

namespace Teren.Api.Tests;

/// <summary>
/// <c>GET /api/entries/{id}/report</c> — the report, downloadable from the app rather than only
/// from the client's mailbox (founder, 2026-08-29, PROJECT.md §11), and **the first read path
/// this system has ever had for object storage**.
/// <para>
/// Served as authenticated bytes, never as a presigned GET: a presigned link works for whoever
/// ends up holding it, and a site diary is a client's commercial data. That decision is what
/// makes the tenancy test below load-bearing rather than ceremonial — this endpoint is the only
/// place the API hands anybody the contents of an object.
/// </para>
/// <para>
/// The three answers are a pinned contract with the PWA: <b>200</b> with the PDF, <b>404</b> for
/// an entry that is not yours (or does not exist), <b>409</b> with a typed <c>code</c> for an
/// entry that is yours but has no report to give. The phone branches on the code, never on the
/// English detail — the same lesson B3 recorded about 409s.
/// </para>
/// </summary>
public sealed class ReportDownloadTests(TerenTestApp app) : ApiTestBase(app)
{
    private static string Route(Guid entryId) => $"/api/entries/{entryId}/report";

    // ---------------------------------------------------------------- 200: the bytes

    [Fact]
    public async Task A_sent_report_downloads_as_the_pdf_that_was_sent()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 2);
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        response.Content.Headers.ContentType!.MediaType.ShouldBe("application/pdf");

        var bytes = await response.Content.ReadAsByteArrayAsync(Ct);
        Encoding.ASCII.GetString(bytes, 0, 5).ShouldBe("%PDF-");

        // Byte-identical to what the relay was handed. Not "a PDF" — *the* PDF: if this path
        // re-rendered, or served a different key, the client's copy and the contractor's copy
        // would be two different documents carrying the same claim.
        App.Delivery.LastSent.ShouldNotBeNull().Attachment.ShouldBe(bytes);
    }

    [Fact]
    public async Task The_download_carries_the_same_file_name_as_the_email_attachment()
    {
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var response = await Client.Get(Route(entryId));
        response.StatusCode.ShouldBe(HttpStatusCode.OK);

        var disposition = response.Content.Headers.ContentDisposition.ShouldNotBeNull();
        disposition.DispositionType.ShouldBe("attachment");

        // One report, one name, whichever way the contractor came by it — a client filing one of
        // these a day should not end up with two spellings of the same document.
        var emailed = App.Delivery.LastSent.ShouldNotBeNull().AttachmentFileName;
        (disposition.FileNameStar ?? disposition.FileName)!.Trim('"').ShouldBe(emailed);
        emailed.ShouldEndWith(".pdf");
    }

    [Fact]
    public async Task The_response_declares_its_length_so_a_download_can_show_progress()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 1);
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var response = await Client.Get(Route(entryId));

        response.Content.Headers.ContentLength.ShouldBe(
            App.Delivery.LastSent.ShouldNotBeNull().Attachment.LongLength);
    }

    [Fact]
    public async Task The_file_name_is_readable_by_a_browser_on_another_origin()
    {
        // Content-Disposition is **not** CORS-safelisted, so a browser hides it from JavaScript
        // unless the API names it in Access-Control-Expose-Headers. The PWA runs at
        // localhost:4200 and the API at localhost:5080, so this is the ordinary case, not an edge
        // one — and the failure is quiet: the download still works, it just saves under a
        // fallback name and nobody traces that back to a CORS header.
        //
        // Found by the frontend agent building against this endpoint, not by this suite. Pinned
        // here so a future CORS tidy-up cannot drop it silently.
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        using var request = new HttpRequestMessage(HttpMethod.Get, Route(entryId));
        request.Headers.Add("Origin", "http://localhost:4200");

        var response = await Client.SendAsync(request, Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        response.Headers.GetValues("Access-Control-Expose-Headers")
            .ShouldContain("Content-Disposition");
    }

    // ---------------------------------------------------------------- 404: tenancy

    [Fact]
    public async Task Another_company_s_report_is_404_and_not_a_download()
    {
        // The mutation target. Company B has a reported entry with a real PDF sitting in storage;
        // company A's device asks for it by id. Drop the tenant filter from the entry lookup —
        // swap db.Entries for db.Entries.IgnoreQueryFilters() — and this is what turns red, with
        // a 200 and another company's site diary in the body.
        var theirEntry = Guid.NewGuid();
        await InsertEntryAsync(
            NewEntry(
                theirEntry,
                TestIds.CompanyB,
                TestIds.ProjectB1,
                EntryStatus.Reported,
                reportedAt: DateTime.UtcNow));

        var theirKey = ObjectKeys.ForEntryReport(
            TestIds.CompanyB, TestIds.ProjectB1, theirEntry);
        var theirPdf = Encoding.ASCII.GetBytes("%PDF-1.7 company B private site diary");
        Storage.PutObject(theirKey, theirPdf);

        await InsertReportAsync(new Report
        {
            Id = Guid.CreateVersion7(),
            CompanyId = TestIds.CompanyB,
            ProjectId = TestIds.ProjectB1,
            EntryId = theirEntry,
            Kind = ReportKind.Daily,
            PeriodStart = Wire.Today,
            PeriodEnd = Wire.Today,
            PdfObjectKey = theirKey,
            PdfSha256 = Convert.ToHexStringLower(SHA256.HashData(theirPdf)),
            Status = ReportStatus.Sent,
            SentAt = DateTime.UtcNow,
            Attempts = 1,
            CreatedAt = DateTime.UtcNow,
        });

        var response = await Client.Get(Route(theirEntry));

        // 404, not 403 and not 409: an entry that is not yours must be indistinguishable from one
        // that does not exist, or the endpoint becomes an oracle for which entry ids are real.
        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await response.TextAsync()).ShouldNotContain("private site diary");
    }

    [Fact]
    public async Task An_entry_that_does_not_exist_is_404()
    {
        var response = await Client.Get(Route(Guid.NewGuid()));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_foreign_entry_and_an_unknown_entry_are_answered_identically()
    {
        // The tenancy doctrine as an equality rather than as two separate assertions: if these
        // two answers ever differ, the endpoint is leaking existence across tenants.
        var theirEntry = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(theirEntry, TestIds.CompanyB, TestIds.ProjectB1));

        var foreign = await Client.Get(Route(theirEntry));
        var unknown = await Client.Get(Route(Guid.NewGuid()));

        foreign.StatusCode.ShouldBe(unknown.StatusCode);
        (await foreign.JsonAsync()).GetProperty("title").GetString()
            .ShouldBe((await unknown.JsonAsync()).GetProperty("title").GetString());
    }

    [Fact]
    public async Task An_id_that_is_not_a_uuid_is_400()
    {
        var response = await Client.Get("/api/entries/not-a-uuid/report");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task The_route_is_behind_the_device_token()
    {
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        using var anonymous = App.CreateAnonymousClient();
        var response = await anonymous.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    // ------------------------------------------------- 409: not ready, and not gone

    [Fact]
    public async Task An_entry_with_no_report_yet_is_409_report_not_ready()
    {
        // The distinction the phone needs, and the reason this is not folded into the 404 above:
        // "yours, not sent yet" is worth polling, "gone" is worth telling the user about. Answer
        // it 404 and the app shows a permanent error for a report that is thirty seconds away.
        var entryId = await GivenConfirmedEntryAsync();

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("report_not_ready");
    }

    [Fact]
    public async Task An_entry_still_awaiting_confirmation_is_409_report_not_ready()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        await ProcessAsync(entryId);

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("report_not_ready");
    }

    [Fact]
    public async Task A_report_still_in_flight_is_409_and_its_pdf_is_not_served()
    {
        // A `sending` row already has its PDF in storage — the row is created after the object is
        // written. Serving it would let the app show a client a report the client has not been
        // sent, and if that pass then fails, a document that officially never existed.
        var entryId = await GivenConfirmedEntryAsync();
        await InsertReportAsync(new Report
        {
            Id = Guid.CreateVersion7(),
            CompanyId = TestIds.CompanyA,
            ProjectId = TestIds.ProjectA1,
            EntryId = entryId,
            Kind = ReportKind.Daily,
            PeriodStart = Wire.Today,
            PeriodEnd = Wire.Today,
            PdfObjectKey = ObjectKeys.ForEntryReport(
                TestIds.CompanyA, TestIds.ProjectA1, entryId),
            Status = ReportStatus.Sending,
            Attempts = 1,
            AttemptStartedAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow,
        });

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("report_not_ready");
    }

    [Fact]
    public async Task A_failed_report_is_409_report_not_ready()
    {
        var entryId = await GivenConfirmedEntryAsync();
        App.Delivery.Configured = false;

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("report_not_ready");
    }

    // ------------------------------------------------------ 409: sent, but not there

    [Fact]
    public async Task A_report_whose_object_has_vanished_is_409_report_unavailable()
    {
        // Distinguished from report_not_ready on purpose: retrying will never fix this, so the
        // app must be able to say something true instead of "try again shortly".
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        Storage.RemoveObject(report.PdfObjectKey!);

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("report_unavailable");
    }

    [Fact]
    public async Task Bytes_that_do_not_match_the_recorded_checksum_are_refused()
    {
        // The same reasoning that makes the report pass verify a photograph's SHA-256 before
        // embedding it, pointed outwards: this is an evidence product, and handing somebody a
        // document that does not match the record — on a product whose whole claim is that the
        // record is trustworthy — is worse than handing back nothing.
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        report.PdfSha256.ShouldNotBeNull("the report pass must record what it stored");

        Storage.PutObject(
            report.PdfObjectKey!,
            Encoding.ASCII.GetBytes("%PDF-1.7 substituted after the fact"));

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("report_unavailable");
        (await response.TextAsync()).ShouldNotContain("substituted after the fact");
    }

    [Fact]
    public async Task A_report_row_without_a_recorded_checksum_is_still_served()
    {
        // Rows written before report.pdf_sha256 existed. A report that was genuinely sent must
        // stay retrievable; the endpoint logs that nothing proved the bytes rather than refusing
        // to hand back a document the client already has a copy of.
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        await ClearRecordedChecksumAsync(entryId);

        var response = await Client.Get(Route(entryId));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        (await response.Content.ReadAsByteArrayAsync(Ct))
            .ShouldBe(App.Delivery.LastSent.ShouldNotBeNull().Attachment);
    }

    // ------------------------------------------------------------------ the checksum

    [Fact]
    public async Task The_report_pass_records_the_checksum_of_what_it_stored()
    {
        var entryId = await GivenConfirmedEntryAsync(photos: 2);
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        var stored = Storage.GetObject(report.PdfObjectKey!).ShouldNotBeNull();

        report.PdfSha256.ShouldBe(Convert.ToHexStringLower(SHA256.HashData(stored)));
    }

    // ------------------------------------------------------------------ helpers

    private static async Task<string?> CodeAsync(HttpResponseMessage response)
    {
        var body = await response.JsonAsync();
        return body.TryGetProperty("code", out var code) ? code.GetString() : null;
    }

    private async Task ClearRecordedChecksumAsync(Guid entryId)
    {
        await using var db = App.CreateDbContext(companyId: null);
        var report = await db.Reports.IgnoreQueryFilters()
            .FirstAsync(r => r.EntryId == entryId, Ct);
        report.PdfSha256 = null;
        await db.SaveChangesAsync(Ct);
    }
}
