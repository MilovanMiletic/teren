using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Jobs;
using Teren.Api.Platform;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Processing;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// <c>GET /api/platform/health</c> — the last endpoint F7's health page needed (plan §8): pipeline
/// state counts, failure tallies, delivery failures and queue depth, broken down by company and
/// site name.
///
/// <para>
/// <b>Two things are on trial here and the second is the important one.</b> The first is
/// arithmetic: the numbers have to be right and the wire shape has to be the one the frontend will
/// be written against. The second is the privacy line, because this endpoint is the only thing on
/// the platform surface that reads the evidence tables at all — and what it must be incapable of
/// carrying is a site's address, a client's inbox, a transcript, a photograph or a report. That is
/// asserted here against the raw JSON rather than against a DTO, because a DTO assertion proves
/// what somebody remembered to look at.
/// </para>
/// </summary>
public sealed class PlatformHealthTests(TerenTestApp app) : ApiTestBase(app)
{
    private async Task<JsonElement> HealthAsync()
    {
        using var staff = await GivenSuperAdminClientAsync();
        var response = await staff.Get("/api/platform/health");

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        return await response.JsonAsync();
    }

    private static JsonElement SiteOf(JsonElement health, Guid projectId) =>
        health.GetProperty("sites").EnumerateArray()
            .Single(s => s.GetGuid("project_id") == projectId);

    // ------------------------------------------------------------------ the estate

    [Fact]
    public async Task Every_site_of_every_customer_is_named_including_the_empty_ones()
    {
        // An empty site is a real state — two of the three demo sites are in it — and a health
        // page that hid them would be unable to say "this customer has never recorded anything",
        // which is exactly the onboarding a founder chases.
        var health = await HealthAsync();

        var sites = health.GetProperty("sites").EnumerateArray().ToList();

        sites.Select(s => s.GetGuid("project_id")).ShouldBe(
            [TestIds.ProjectA1, TestIds.ProjectA2, TestIds.ProjectB1], ignoreOrder: true);

        SiteOf(health, TestIds.ProjectA1).GetText("project_name")
            .ShouldBe("Stambena zgrada Vojvode Stepe 212");
        SiteOf(health, TestIds.ProjectA1).GetText("company_name").ShouldBe(TestIds.CompanyAName);
        SiteOf(health, TestIds.ProjectB1).GetText("company_name").ShouldBe("Druga firma d.o.o.");

        SiteOf(health, TestIds.ProjectA2).GetProperty("pipeline")
            .GetProperty("entry_count").GetInt32().ShouldBe(0);
        health.GetProperty("sites_omitted").GetInt32().ShouldBe(0);
    }

    [Fact]
    public async Task Pipeline_states_are_counted_per_site_and_across_the_estate()
    {
        await GivenEntryAsync();
        await GivenEntryAsync();
        var parked = await GivenEntryAsync(projectId: TestIds.ProjectA2);

        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var entry = await db.Entries.FindAsync([parked], Ct);
            entry!.Status = EntryStatus.NeedsReview;
            await db.SaveChangesAsync(Ct);
        }

        var health = await HealthAsync();

        var estate = health.GetProperty("pipeline");
        estate.GetProperty("entry_count").GetInt32().ShouldBe(3);
        estate.GetProperty("received").GetInt32().ShouldBe(2);
        estate.GetProperty("needs_review").GetInt32().ShouldBe(1);
        estate.GetProperty("reported").GetInt32().ShouldBe(0);

        SiteOf(health, TestIds.ProjectA1).GetProperty("pipeline")
            .GetProperty("received").GetInt32().ShouldBe(2);
        SiteOf(health, TestIds.ProjectA2).GetProperty("pipeline")
            .GetProperty("needs_review").GetInt32().ShouldBe(1);
        SiteOf(health, TestIds.ProjectB1).GetProperty("pipeline")
            .GetProperty("entry_count").GetInt32().ShouldBe(0);
    }

    [Fact]
    public async Task The_six_states_add_up_to_the_entry_count()
    {
        // The claim the block makes on the screen. A seventh status added to the state machine
        // without a line here would show up as a total that does not match its own columns.
        await GivenEntryAsync();
        var reported = await GivenConfirmedEntryAsync();
        (await ReportAsync(reported)).ShouldBe(ReportOutcome.Sent);

        var pipeline = (await HealthAsync()).GetProperty("pipeline");

        var states = new[]
        {
            "received", "processing", "awaiting_confirmation", "needs_review", "confirmed",
            "reported",
        };

        states.Sum(name => pipeline.GetProperty(name).GetInt32())
            .ShouldBe(pipeline.GetProperty("entry_count").GetInt32());
        pipeline.GetProperty("reported").GetInt32().ShouldBe(1);
    }

    // ------------------------------------------------------------------ failure tallies

    [Fact]
    public async Task A_failure_tally_carries_the_code_and_never_the_detail()
    {
        // The detail half of a stored reason is written by the pipeline and folds in an external
        // provider's own message in at least one place — the same text that keeps
        // AiProviderException off the log sink's exception allow-list (ARCHITECTURE §12). It must
        // not reach a super admin's screen through this door either.
        const string Detail = "the provider said something about a customer's site";

        var first = await GivenEntryAsync();
        var second = await GivenEntryAsync();
        var other = await GivenEntryAsync(projectId: TestIds.ProjectA2);

        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            foreach (var id in new[] { first, second })
            {
                var entry = await db.Entries.FindAsync([id], Ct);
                entry!.Status = EntryStatus.NeedsReview;
                entry.FailureReason = ProcessingFailure.Describe(
                    ProcessingFailure.TranscriptionFailed, Detail);
            }

            var parked = await db.Entries.FindAsync([other], Ct);
            parked!.Status = EntryStatus.NeedsReview;
            parked.FailureReason = ProcessingFailure.Describe(
                ProcessingFailure.NoEvidence, "no audio and no text");

            await db.SaveChangesAsync(Ct);
        }

        using var staff = await GivenSuperAdminClientAsync();
        var raw = await (await staff.Get("/api/platform/health")).TextAsync();
        var health = JsonDocument.Parse(raw).RootElement;

        var tallies = health.GetProperty("pipeline_failures").EnumerateArray()
            .ToDictionary(t => t.GetText("reason"), t => t.GetProperty("count").GetInt32());

        tallies[ProcessingFailure.TranscriptionFailed].ShouldBe(2);
        tallies[ProcessingFailure.NoEvidence].ShouldBe(1);

        raw.ShouldNotContain(Detail, Case.Insensitive);

        // And attributed to the right site, which is the whole point of the breakdown.
        SiteOf(health, TestIds.ProjectA2).GetProperty("pipeline_failures").EnumerateArray()
            .Select(t => t.GetText("reason")).ShouldBe([ProcessingFailure.NoEvidence]);
    }

    [Fact]
    public async Task A_reason_that_is_not_in_the_vocabulary_is_reported_as_unrecognised()
    {
        // CodeOf splits on the first colon and returns the WHOLE STRING when there is none, so a
        // reason written by some future path without the conventional shape would arrive on a
        // platform response as free text. The vocabulary check is what makes the guarantee
        // absolute: every string on this response other than a company or a site name is a
        // constant compiled into this assembly.
        const string Rogue = "Zoran je rekao da su cevi u zidu iza kupatila";

        var entry = await GivenEntryAsync();
        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var row = await db.Entries.FindAsync([entry], Ct);
            row!.Status = EntryStatus.NeedsReview;
            row.FailureReason = Rogue;
            await db.SaveChangesAsync(Ct);
        }

        using var staff = await GivenSuperAdminClientAsync();
        var raw = await (await staff.Get("/api/platform/health")).TextAsync();

        raw.ShouldNotContain("Zoran");
        raw.ShouldNotContain("cevi");

        JsonDocument.Parse(raw).RootElement
            .GetProperty("pipeline_failures").EnumerateArray()
            .Select(t => t.GetText("reason"))
            .ShouldBe([FailureVocabulary.Unrecognised]);
    }

    [Fact]
    public void The_vocabulary_is_read_off_the_source_and_is_not_empty()
    {
        // Anti-vacuity for the check above: an empty vocabulary would fold every real code into
        // `unrecognised` and the assertion would still pass. And the prefix constants — which
        // exist for the one predicate that has to ask in SQL — must not be mistaken for codes.
        FailureVocabulary.Pipeline.ShouldContain(ProcessingFailure.ExtractionNotConfigured);
        FailureVocabulary.Pipeline.ShouldContain(ProcessingFailure.ProcessingInterrupted);
        FailureVocabulary.Pipeline.Count.ShouldBeGreaterThan(8);

        FailureVocabulary.Delivery.ShouldContain(ReportFailure.SupersededAfterSend);
        FailureVocabulary.Delivery.ShouldContain(ReportFailure.DeliveryCustodyUnknown);
        FailureVocabulary.Delivery.ShouldNotContain(ReportFailure.ReportInterruptedPrefix);
        FailureVocabulary.Delivery.Count.ShouldBeGreaterThan(8);

        // And the union that `entry.failure_reason` is folded through, because that column is
        // written from both sides. Checking the union exists is not enough on its own — the two
        // tests above are what prove entry buckets actually go through it.
        FailureVocabulary.Entry.ShouldBe(
            FailureVocabulary.Pipeline.Concat(FailureVocabulary.Delivery).ToHashSet(),
            ignoreOrder: true);
        FailureVocabulary.Entry.ShouldContain(ReportFailure.SupersededAfterSend);
        FailureVocabulary.Entry.ShouldContain(ProcessingFailure.NoEvidence);
    }

    [Fact]
    public async Task A_delivery_failure_is_named_on_the_entry_too_and_never_as_unrecognised()
    {
        // THE MISTAKE THIS TEST EXISTS FOR. `entry.failure_reason` is not the pipeline's private
        // column: EntryReporter.FailAsync writes a ReportFailure code to it deliberately, "in both
        // places a person might look". Folding entry buckets through the ProcessingFailure
        // vocabulary alone therefore reported every delivery failure TWICE — correctly under
        // `delivery_failures` and again as `unrecognised` under `pipeline_failures` — and the
        // vocabulary test could not see it, because it checks the contents of the sets rather than
        // which set a bucket is folded through.
        var refused = await GivenConfirmedEntryAsync();
        App.Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "the relay refused the address", ReportDeliveryFailureKind.Rejected);
        (await ReportAsync(refused)).ShouldBe(ReportOutcome.Failed);
        App.Delivery.Fails = null;

        var health = await HealthAsync();

        var onTheEntry = health.GetProperty("pipeline_failures").EnumerateArray()
            .ToDictionary(t => t.GetText("reason"), t => t.GetProperty("count").GetInt32());

        onTheEntry.ShouldContainKey(ReportFailure.DeliveryRejected);
        onTheEntry[ReportFailure.DeliveryRejected].ShouldBe(1);
        onTheEntry.ShouldNotContainKey(
            FailureVocabulary.Unrecognised,
            "a code this product declares must never be reported as one it does not recognise");

        // Still counted once on the delivery side, which is the other half of the fact.
        health.GetProperty("delivery_failures").EnumerateArray()
            .Select(t => t.GetText("reason")).ShouldBe([ReportFailure.DeliveryRejected]);
    }

    [Fact]
    public async Task Superseded_after_send_is_tallied_by_its_own_name()
    {
        // The state whose documented remedy is "resolve by hand — a correction after a report is a
        // new entry": a report was delivered and the entry then changed, so `reported_at` was
        // never stamped and never can be. It lives ONLY on entry.failure_reason — there is no
        // report row carrying it — so if entry buckets are folded through the wrong vocabulary it
        // is invisible by name on the one screen that exists to say what is wrong.
        var entryId = await GivenConfirmedEntryAsync();

        var raced = DefaultCorrected();
        raced["notes"] = "Ispravka koja je stigla dok je izveštaj već bio kod relaya.";

        App.Delivery.WhileSending = async () =>
        {
            App.Delivery.WhileSending = null;
            await using var db = App.CreateDbContext(TestIds.CompanyA);
            await db.Entries.Where(e => e.Id == entryId)
                .ExecuteUpdateAsync(
                    u => u.SetProperty(e => e.Corrected, raced.ToJsonString()), Ct);
        };

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.ReportedAt.ShouldBeNull("the arrange did not reach superseded_after_send");
        ReportFailure.CodeOf(entry.FailureReason).ShouldBe(ReportFailure.SupersededAfterSend);

        var health = await HealthAsync();

        health.GetProperty("pipeline_failures").EnumerateArray()
            .Select(t => t.GetText("reason"))
            .ShouldContain(ReportFailure.SupersededAfterSend);

        SiteOf(health, TestIds.ProjectA1).GetProperty("pipeline_failures").EnumerateArray()
            .Select(t => t.GetText("reason"))
            .ShouldContain(ReportFailure.SupersededAfterSend);

        // And the report row itself is truthfully `sent` — the relay did take that message.
        health.GetProperty("delivery").GetProperty("sent").GetInt32().ShouldBe(1);
    }

    // ------------------------------------------------------------------ delivery

    [Fact]
    public async Task Delivery_counts_what_went_out_and_tallies_what_did_not()
    {
        var sent = await GivenConfirmedEntryAsync();
        (await ReportAsync(sent)).ShouldBe(ReportOutcome.Sent);

        var refused = await GivenConfirmedEntryAsync();
        App.Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "the relay refused the address", ReportDeliveryFailureKind.Rejected);
        (await ReportAsync(refused)).ShouldBe(ReportOutcome.Failed);
        App.Delivery.Fails = null;

        var health = await HealthAsync();

        var delivery = health.GetProperty("delivery");
        delivery.GetProperty("report_count").GetInt32().ShouldBe(2);
        delivery.GetProperty("sent").GetInt32().ShouldBe(1);
        delivery.GetProperty("failed").GetInt32().ShouldBe(1);
        delivery.GetProperty("sending").GetInt32().ShouldBe(0);

        health.GetProperty("delivery_failures").EnumerateArray()
            .Select(t => t.GetText("reason"))
            .ShouldContain(ReportFailure.DeliveryRejected);

        SiteOf(health, TestIds.ProjectA1).GetProperty("delivery")
            .GetProperty("sent").GetInt32().ShouldBe(1);
    }

    // ------------------------------------------------------------------ the queue

    [Fact]
    public async Task An_unknown_queue_is_reported_as_unknown_and_not_as_empty()
    {
        // The test host runs with no job server, which is the shipped answer for a host that
        // switched Hangfire off. An empty queue is the healthiest state there is and "nobody is
        // running a job server" is one of the worst; a screen that drew them the same way would
        // tell a founder the most reassuring version of the worst state the system has.
        var queue = (await HealthAsync()).GetProperty("queue");

        queue.GetProperty("available").GetBoolean().ShouldBeFalse();
        queue.GetText("detail").ShouldBe(JobQueueDepth.NotConfigured);
        queue.GetProperty("enqueued").GetInt32().ShouldBe(0);
    }

    [Fact]
    public void The_switched_off_queue_reader_itself_answers_unknown()
    {
        // Asserted directly on the production class, and it is not redundant with the test above:
        // the fixture SUBSTITUTES this seam, so every host-level assertion about "unknown" is
        // really an assertion about the fake. A mutation found that — turning
        // DisabledJobQueueDepth into "available, everything zero" left the whole suite green — so
        // the one line that decides whether a founder is told the truth about a host with no job
        // server is pinned where it actually lives.
        var reading = new DisabledJobQueueDepth().Read();

        reading.Available.ShouldBeFalse();
        reading.Detail.ShouldBe(JobQueueDepth.NotConfigured);
        reading.Servers.ShouldBe(0);
    }

    [Fact]
    public async Task A_readable_queue_reports_its_depth()
    {
        App.Queue.Depth = new JobQueueDepth(
            Available: true, Detail: null,
            Enqueued: 7, Scheduled: 3, Processing: 2, Failed: 1, Servers: 1);

        var queue = (await HealthAsync()).GetProperty("queue");

        queue.GetProperty("available").GetBoolean().ShouldBeTrue();
        queue.IsNull("detail").ShouldBeTrue();
        queue.GetProperty("enqueued").GetInt32().ShouldBe(7);
        queue.GetProperty("scheduled").GetInt32().ShouldBe(3);
        queue.GetProperty("processing").GetInt32().ShouldBe(2);
        queue.GetProperty("failed").GetInt32().ShouldBe(1);
        queue.GetProperty("servers").GetInt32().ShouldBe(1);
    }

    // ------------------------------------------------------------------ ordering

    [Fact]
    public async Task Sites_needing_attention_come_first()
    {
        // The order is what makes the cap on the site list safe: truncation can then only ever
        // drop a healthy site. Without it, an alphabetical cut would hide the failures.
        //
        // THE ARRANGEMENT IS THE TEST. The needy site has to be the one alphabetical order would
        // put LAST, or the assertion passes under either rule and proves nothing — the first cut
        // of this test parked a day on company B, whose name ("Druga firma") already sorts before
        // company A's ("Vodoinstal Petrović"), and it survived removing the ordering entirely.
        // `Vodoinstal Petrović d.o.o.` / `Zgrada B` is the last of the three.
        var parked = await GivenEntryAsync(projectId: TestIds.ProjectA2);
        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var entry = await db.Entries.FindAsync([parked], Ct);
            entry!.Status = EntryStatus.NeedsReview;
            await db.SaveChangesAsync(Ct);
        }

        var sites = (await HealthAsync()).GetProperty("sites").EnumerateArray().ToList();

        sites.Select(site => site.GetGuid("project_id")).ShouldBe(
            [TestIds.ProjectA2, TestIds.ProjectB1, TestIds.ProjectA1],
            "the one site with a day parked in front of a human comes first, and the other two "
            + "follow it alphabetically by customer then site");
    }

    // ------------------------------------------------------------------ the wire shape

    [Fact]
    public async Task The_response_names_exactly_these_fields()
    {
        // Pinned exhaustively and against the JSON, which is F4's lesson: the frontend half of
        // this increment is written against these names, and a client reading a field the server
        // does not send gets `undefined` and no error.
        var health = await HealthAsync();

        Names(health).ShouldBe(
        [
            "at", "delivery", "delivery_failures", "pipeline", "pipeline_failures", "queue",
            "sites", "sites_omitted",
        ]);

        Names(health.GetProperty("pipeline")).ShouldBe(
        [
            "awaiting_confirmation", "confirmed", "entry_count", "needs_review", "processing",
            "received", "reported",
        ]);

        Names(health.GetProperty("delivery")).ShouldBe(
            ["failed", "report_count", "sending", "sent"]);

        Names(health.GetProperty("queue")).ShouldBe(
        [
            "available", "detail", "enqueued", "failed", "processing", "scheduled", "servers",
        ]);

        Names(SiteOf(health, TestIds.ProjectA1)).ShouldBe(
        [
            "company_id", "company_name", "delivery", "delivery_failures", "pipeline",
            "pipeline_failures", "project_id", "project_name",
        ]);
    }

    [Fact]
    public async Task A_failure_tally_is_a_reason_and_a_count()
    {
        var entry = await GivenEntryAsync();
        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var row = await db.Entries.FindAsync([entry], Ct);
            row!.Status = EntryStatus.NeedsReview;
            row.FailureReason = ProcessingFailure.Describe(
                ProcessingFailure.ExtractionInvalid, "not a v1 structure");
            await db.SaveChangesAsync(Ct);
        }

        var tally = (await HealthAsync()).GetProperty("pipeline_failures")
            .EnumerateArray().Single();

        Names(tally).ShouldBe(["count", "reason"]);
    }

    private static string[] Names(JsonElement element) =>
        [.. element.EnumerateObject().Select(p => p.Name)
            .OrderBy(name => name, StringComparer.Ordinal)];

    // ------------------------------------------------------------------ the privacy line

    [Fact]
    public async Task Nothing_about_a_site_but_its_name_reaches_the_response()
    {
        // Asserted against the raw JSON, because a DTO assertion only proves what somebody
        // remembered to look at. All four of these are on the project row this response reads
        // from, and none of them is in the model it reads through
        // (PlatformProjectConfiguration Ignores them, so no query written there could select one).
        await GivenEntryAsync();

        using var staff = await GivenSuperAdminClientAsync();
        var raw = await (await staff.Get("/api/platform/health")).TextAsync();

        raw.ShouldNotContain("Vojvode Stepe 212, Voždovac", Case.Insensitive);
        raw.ShouldNotContain("44.769");
        raw.ShouldNotContain("20.478");
        raw.ShouldNotContain("dragan.obradovic@example.com", Case.Insensitive);
        raw.ShouldNotContain("jelena.markovic@example.com", Case.Insensitive);
    }

    [Fact]
    public async Task No_entry_id_transcript_or_report_id_reaches_the_response()
    {
        // A day of work exists, has been transcribed, confirmed and reported. None of it is
        // nameable from this surface: not the entry id, not the words the foreman said, not the
        // id of the document his client received.
        var entryId = await GivenConfirmedEntryAsync(photos: 1);

        // The transcript the pipeline actually wrote for this entry, read rather than planted:
        // `raw_transcript` is write-once (trigger-enforced) and a reported row cannot be written
        // at all, which the first two cuts of this test found out the hard way.
        string spoken;
        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            spoken = (await db.Entries.AsNoTracking().FirstAsync(e => e.Id == entryId, Ct))
                .RawTranscript.ShouldNotBeNull("the arrange did not produce a transcript");
        }

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var reportId = await ReportIdOfAsync(entryId);
        var objectKey = await PhotoKeyOfAsync(entryId);

        using var staff = await GivenSuperAdminClientAsync();
        var raw = await (await staff.Get("/api/platform/health")).TextAsync();

        raw.ShouldNotContain(entryId.ToString(), Case.Insensitive);
        raw.ShouldNotContain(reportId.ToString(), Case.Insensitive);
        raw.ShouldNotContain(objectKey, Case.Insensitive);
        raw.ShouldNotContain(spoken, Case.Insensitive);
    }

    private async Task<Guid> ReportIdOfAsync(Guid entryId)
    {
        await using var db = App.CreateDbContext(TestIds.CompanyA);
        return (await db.Reports.AsNoTracking()
            .FirstAsync(r => r.EntryId == entryId, Ct)).Id;
    }

    private async Task<string> PhotoKeyOfAsync(Guid entryId)
    {
        await using var db = App.CreateDbContext(TestIds.CompanyA);
        return (await db.Media.AsNoTracking()
            .FirstAsync(m => m.EntryId == entryId && m.Kind == MediaKind.Photo, Ct)).ObjectKey;
    }

    [Fact]
    public async Task A_foreman_and_a_company_admin_are_both_refused()
    {
        // Layer 1, from the other side: the customer cannot see the platform, exactly as the
        // platform cannot see his diaries. Refused by RoleFilter before a row is read.
        (await Client.Get("/api/platform/health")).StatusCode
            .ShouldBe(HttpStatusCode.Forbidden);

        using var customer = await GivenCompanyAdminClientAsync();
        (await customer.Get("/api/platform/health")).StatusCode
            .ShouldBe(HttpStatusCode.Forbidden);
    }
}
