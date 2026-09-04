using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Reporting;
using Teren.Core.Time;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The report says what it supersedes (founder decision, 2026-09-03).
///
/// <para>
/// <b>Why the increment exists.</b> <c>supersedes_entry_id</c> reaches the server, so a correction
/// exists as a record — but the PDF the client received said nothing about the document it
/// replaces, and so arrived looking like an unrelated day. That is weak evidence in precisely the
/// dispute a correction exists for: the client is <em>already holding</em> the wrong report, and
/// nothing in the new one tells him which of the two to believe.
/// </para>
///
/// <para>
/// <b>Every claim here is read back out of the rendered PDF</b> (PdfPig), never asserted against
/// the model handed to the builder. A renderer that took the correction and drew nothing with it
/// would pass any "was it passed in" test — and that is the failure mode this increment is one
/// mistake away from.
/// </para>
///
/// <para>
/// The four cases are the founder's: a correction of a reported day, a correction of a day whose
/// own report failed, a chain (which names its <em>immediate</em> predecessor), and an ordinary
/// entry, which must print nothing extra at all.
/// </para>
///
/// <para>
/// The Serbian and English copy is drafted by Claude and <b>owes the founder's review</b> — it is
/// a sentence a contractor's client reads at a bad moment.
/// </para>
/// </summary>
public sealed class ReportCorrectionTests : IDisposable
{
    /// <summary>The day being corrected. Deliberately not the report's own date, so an assertion
    /// on the superseded day cannot pass on the masthead's date by accident.</summary>
    private static readonly DateOnly SupersededDay = new(2026, 8, 27);

    /// <summary>When the superseded report went out. 22:40 UTC is 00:40 the next day in Belgrade,
    /// so a timestamp printed in UTC differs from the correct one in the <em>date</em> as well as
    /// the time — which is what makes "project-local" provable rather than plausible.</summary>
    private static readonly DateTimeOffset SupersededSentAt =
        new(2026, 8, 27, 22, 40, 0, TimeSpan.Zero);

    private static readonly QuestPdfReportRenderer Renderer = new(
        Options.Create(new ReportingOptions()),
        NullLogger<QuestPdfReportRenderer>.Instance);

    private readonly string _workspace = Path.Combine(
        Path.GetTempPath(), "teren-correction-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_workspace))
        {
            Directory.Delete(_workspace, recursive: true);
        }
    }

    // ----------------------------------------------------- the headline: it names its predecessor

    [Theory]
    [InlineData("sr")]
    [InlineData("en")]
    public void A_correction_names_the_day_it_replaces_and_when_that_report_was_sent(
        string language)
    {
        var pdf = Renderer.RenderDaily(Correction(language));
        var s = ReportStrings.For(language);

        PdfText.Contains(pdf, s.CorrectionHeading.ToUpperInvariant()).ShouldBeTrue(
            "a correction must announce itself where a reader cannot miss it\n\n" + PdfText.Of(pdf));

        // The whole sentence, with the day and the send time in it — because "the words are
        // somewhere on the page" is not the claim. The claim is that a client can read which
        // document this one replaces.
        PdfText.Contains(
                pdf,
                string.Format(
                    s.NumberCulture,
                    s.CorrectionOfSentReport,
                    s.FormatDate(SupersededDay),
                    s.FormatTimestamp(SupersededSentAt, Belgrade)))
            .ShouldBeTrue(
                "the client has to be told which document is being replaced\n\n" + PdfText.Of(pdf));
    }

    [Fact]
    public void The_date_and_the_send_time_are_the_sites_own_local_time()
    {
        // Ruling 3: every timestamp on this document is the date the client would recognise. The
        // send time here is 22:40 UTC, which is 00:40 on the 28th in Belgrade — so a page rendered
        // in UTC would name a different day, on the one line whose job is naming a document.
        var pdf = Renderer.RenderDaily(Correction("sr"));
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.FormatTimestamp(SupersededSentAt, Belgrade)).ShouldBeTrue(
            "28.08.2026. 00:40 (UTC+2)\n\n" + PdfText.Of(pdf));
        PdfText.Contains(pdf, s.FormatTimestamp(SupersededSentAt, TimeZoneInfo.Utc)).ShouldBeFalse(
            "a UTC stamp on a client's document names the wrong evening");
    }

    [Fact]
    public void A_correction_of_a_day_that_was_never_sent_does_not_claim_it_was()
    {
        // The founder's second case, and the one direction that must never be smoothed over: a
        // reader must not be sent hunting his inbox for a report that never left the building.
        var pdf = Renderer.RenderDaily(Correction("sr") with
        {
            Correction = new ReportCorrection(SupersededDay, null, null),
        });
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.CorrectionHeading.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(
                pdf,
                string.Format(
                    s.NumberCulture, s.CorrectionOfUnsentRecord, s.FormatDate(SupersededDay)))
            .ShouldBeTrue(PdfText.Of(pdf));

        // And no send time anywhere: there is nothing to name.
        PdfText.Contains(pdf, s.FormatTimestamp(SupersededSentAt, Belgrade)).ShouldBeFalse();
    }

    [Fact]
    public void The_serbian_date_does_not_print_two_full_stops()
    {
        // `dd.MM.yyyy.` already ends in a full stop, so a sentence that ended with the superseded
        // day printed `02.09.2026..` — which the first draft of the unsent variant did. Read off a
        // rendered PDF, not off the template; the same trap the report email's first line had.
        foreach (var report in new[]
                 {
                     Correction("sr"),
                     Correction("sr") with
                     {
                         Correction = new ReportCorrection(SupersededDay, null, null),
                     },
                 })
        {
            var text = PdfText.Of(Renderer.RenderDaily(report));
            text.Contains("..", StringComparison.Ordinal).ShouldBeFalse(text);
        }
    }

    [Fact]
    public void The_record_block_repeats_the_correction_where_a_checker_looks()
    {
        // Said twice on purpose, exactly as the verbatim variant is: the band is for the reader
        // skimming the day, this is for the one reconciling two PDFs.
        var pdf = Renderer.RenderDaily(Correction("sr"));
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.Corrects).ShouldBeTrue(PdfText.Of(pdf));
        PdfText.Contains(pdf, $"{s.Corrects} {s.FormatDate(SupersededDay)}").ShouldBeTrue(
            "the label and the day belong on one line of the record block\n\n" + PdfText.Of(pdf));
    }

    [Fact]
    public void A_predecessor_on_another_site_is_named_by_site_as_well_as_by_day()
    {
        // `POST /entries` refuses a cross-site link, so this is the abnormal row — one written
        // before that check existed, or by hand. A bare date would then name a document that
        // belongs in somebody else's inbox, which is the one way this line is worse than silence.
        var pdf = Renderer.RenderDaily(Correction("sr") with
        {
            Correction = new ReportCorrection(SupersededDay, "Zgrada B", SupersededSentAt),
        });
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, $"{s.Site}: Zgrada B").ShouldBeTrue(PdfText.Of(pdf));
    }

    [Theory]
    [InlineData("sr")]
    [InlineData("en")]
    public void The_unsent_variant_states_the_fact_and_claims_nothing_beyond_it(string language)
    {
        // The D9 review's first gating find. This variant used to end "— ovo je jedini izveštaj za
        // taj dan" / "so this is the only report for that day": the first clause is a fact read off
        // the `report` row, the second was a promise about the future that nothing in the money
        // path keeps. Re-confirming the predecessor re-queues it and `ReportAsync` never asks
        // whether it has been superseded, so a second document for the same day can follow; and in
        // a chain (proven end to end below) a delivered report for that day already exists.
        //
        // Asserted as a vocabulary check on the rendered page rather than against the constant,
        // because a test that formats `CorrectionOfUnsentRecord` and looks for it would pass with
        // the clause put back — the claim would be in both halves of the comparison.
        var pdf = Renderer.RenderDaily(Correction(language) with
        {
            Correction = new ReportCorrection(SupersededDay, null, null),
        });
        var s = ReportStrings.For(language);
        var text = PdfText.Of(pdf);

        PdfText.Contains(
                pdf,
                string.Format(
                    s.NumberCulture, s.CorrectionOfUnsentRecord, s.FormatDate(SupersededDay)))
            .ShouldBeTrue(text);

        foreach (var claim in ExclusivityClaims(language))
        {
            PdfText.Contains(pdf, claim).ShouldBeFalse(
                $"an evidence document must not promise \"{claim}\" — nothing enforces it, and "
                + "PROJECT.md §5 invariant 2 makes a second record of a day the normal remedy\n\n"
                + text);
        }
    }

    // ------------------------------------------------------------- what a correction never prints

    [Fact]
    public void No_identifier_of_the_superseded_record_can_reach_the_page()
    {
        // Ruling 1, structurally: the record id came off this page because a GUID means nothing to
        // an investor, and a correction is exactly where somebody would put one back "so it is
        // unambiguous". The type cannot carry one, so the renderer cannot print one.
        var carried = typeof(ReportCorrection)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.PropertyType == typeof(Guid) || p.PropertyType == typeof(Guid?))
            .Select(p => p.Name)
            .ToList();

        carried.ShouldBeEmpty(
            "a client's document names a superseded record by project and date, never by id "
            + "(PROJECT.md §11 ruling 1). If that is being reversed it is a founder decision.");
    }

    [Fact]
    public void An_ordinary_day_prints_nothing_extra_at_all()
    {
        // The half nobody would notice breaking. An entry that corrects nothing must render
        // exactly as it always has — no heading, no line in the record block, not a word.
        var pdf = Renderer.RenderDaily(Ordinary("sr"));
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.CorrectionHeading.ToUpperInvariant()).ShouldBeFalse(
            "an ordinary day must never be presented as a correction");
        PdfText.Contains(pdf, s.Corrects).ShouldBeFalse();
        PdfText.Contains(pdf, s.FormatDate(SupersededDay)).ShouldBeFalse();

        // …and everything an ordinary day always printed still prints.
        PdfText.Contains(pdf, s.WorkDone.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.RecordSection.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.CapturedAt).ShouldBeTrue();
    }

    [Fact]
    public void The_two_documents_are_genuinely_different()
    {
        // A renderer that read the correction and did nothing with it would pass every "is it a
        // PDF" assertion in the suite.
        Renderer.RenderDaily(Correction("sr")).ShouldNotBe(Renderer.RenderDaily(Ordinary("sr")));
    }

    [Fact]
    public void A_correction_still_carries_the_evidence_the_document_always_carried()
    {
        // "This changes the standing of the document, nothing else." Photographs, the checksum
        // statement and the record block still apply exactly as before.
        var pdf = Renderer.RenderDaily(Correction("sr", photos: 2));
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.Photos.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.EvidenceNote).ShouldBeTrue();
        PdfText.Contains(pdf, s.CapturedAt).ShouldBeTrue();
    }

    [Fact]
    public void A_verbatim_day_can_also_be_a_correction()
    {
        // Both variants are statements about where the document stands, and they compose: the
        // floor ("his own words") is exactly the state a foreman is in when he re-records a day
        // the AI mangled, so this pair is the likely one rather than the exotic one.
        var pdf = Renderer.RenderDaily(Correction("sr") with
        {
            Content = ReportContent.Empty with
            {
                Notes = "Ispravka: juče je bilo pet radnika, ne tri. Đubre je odneto danas.",
                DescribedVerbatim = true,
            },
        });
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.CorrectionHeading.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.VerbatimDescription.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, "Đubre je odneto danas.").ShouldBeTrue(PdfText.Of(pdf));
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>
    /// The words the unsent variant is forbidden to print, per language — the clause the D9 review
    /// took off it, plus the obvious paraphrase somebody would reach for putting it back.
    /// <para>
    /// Literal copy on purpose: this is the one assertion in the file that must not be derived
    /// from <see cref="ReportStrings"/>, or restoring the clause would satisfy it.
    /// </para>
    /// </summary>
    internal static string[] ExclusivityClaims(string language) => language == "sr"
        ? ["jedini izveštaj", "jedini zapis", "samo ovaj izveštaj"]
        : ["the only report", "the only record", "this is the only"];

    private static TimeZoneInfo Belgrade => ReportTimeZone.Resolve(ReportTimeZone.Default);

    private DailyReport Correction(string language, int photos = 0) =>
        Ordinary(language, photos) with
        {
            Correction = new ReportCorrection(SupersededDay, null, SupersededSentAt),
        };

    private DailyReport Ordinary(string language, int photos = 0)
    {
        Directory.CreateDirectory(_workspace);

        var images = new List<ReportPhoto>(photos);
        for (var index = 0; index < photos; index++)
        {
            var path = Path.Combine(_workspace, $"{index}.png");
            if (!File.Exists(path))
            {
                File.WriteAllBytes(path, TestImage.Png(index, 1600, 1200));
            }

            images.Add(new ReportPhoto(
                Guid.NewGuid(), path, new string('b', 64), DateTimeOffset.UtcNow.AddHours(-3)));
        }

        return new DailyReport(
            "Vodoinstal Petrović d.o.o.",
            "Stambena zgrada Vojvode Stepe 212",
            "Vojvode Stepe 212, Voždovac, Beograd",
            new DateOnly(2026, 8, 29),
            language,
            ReportTimeZone.Default,
            new ReportContent(
                [new WorkDoneItem(
                    "Razvod tople i hladne vode", "zapadno krilo, 2. sprat",
                    new ReportQuantity(40, "m"))],
                new ReportHeadcount(5, [new ReportRole("vodoinstalater", 5)]),
                [new MaterialItem("PPR cev 25mm", new ReportQuantity(40, "m"), true)],
                [],
                [],
                null),
            images,
            new ReportProvenance(
                Guid.NewGuid(),
                new DateTimeOffset(2026, 8, 29, 14, 32, 0, TimeSpan.Zero),
                new DateTimeOffset(2026, 8, 29, 14, 33, 0, TimeSpan.Zero),
                new DateTimeOffset(2026, 8, 29, 14, 35, 0, TimeSpan.Zero)));
    }
}

/// <summary>
/// The same increment from the wire: a correction posted by a phone, through the real report pass,
/// into the bytes a relay was handed.
///
/// <para>
/// The render tests above prove the layout. These prove that the <b>right</b> predecessor is named
/// — which is a question about three database reads, and the one the layout cannot answer. The
/// send time comes off the <c>report</c> row rather than off the superseded entry's seal, because
/// <c>superseded_after_send</c> is a report that went out and an entry deliberately left unsealed;
/// keying on the seal would print "never sent" over a document the client is holding.
/// </para>
/// </summary>
public sealed class ReportCorrectionEndToEndTests(TerenTestApp app) : ApiTestBase(app)
{
    private static readonly DateOnly Today = Wire.Today;
    private static readonly DateOnly Yesterday = Wire.Today.AddDays(-1);
    private static readonly DateOnly TwoDaysAgo = Wire.Today.AddDays(-2);

    [Fact]
    public async Task A_correction_of_a_reported_day_names_that_day_and_when_it_went_out()
    {
        var original = await GivenConfirmedEntryAsync(entryDate: Yesterday);
        (await ReportAsync(original)).ShouldBe(ReportOutcome.Sent);

        var sentAt = (await LoadReportAsync(original))!.SentAt.ShouldNotBeNull();

        var correction = await GivenConfirmedEntryAsync(
            entryDate: Today, supersedes: original);

        (await ReportAsync(correction)).ShouldBe(ReportOutcome.Sent);

        // Not the model the renderer was handed — the bytes that left the building.
        var attachment = App.Delivery.Sent[^1].Attachment;
        var s = ReportStrings.Serbian;

        PdfText.Contains(
                attachment,
                string.Format(
                    s.NumberCulture,
                    s.CorrectionOfSentReport,
                    s.FormatDate(Yesterday),
                    s.FormatTimestamp(
                        UtcStamp.Of(sentAt),
                        ReportTimeZone.Resolve(ReportTimeZone.Default))))
            .ShouldBeTrue(
                "the client already has the superseded report; this line is how he finds it\n\n"
                + PdfText.Of(attachment));
    }

    [Fact]
    public async Task A_correction_of_a_day_whose_report_failed_says_it_was_never_sent()
    {
        // The founder's second case. The predecessor has a `report` row — it was rendered and
        // stored — and nothing ever reached a relay, so the client has never seen that day.
        var original = await GivenConfirmedEntryAsync(entryDate: Yesterday);
        App.Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "the relay refused", ReportDeliveryFailureKind.Rejected);

        (await ReportAsync(original)).ShouldBe(ReportOutcome.Failed);
        (await LoadReportAsync(original))!.SentAt.ShouldBeNull("the arrange did send something");

        App.Delivery.Fails = null;

        var correction = await GivenConfirmedEntryAsync(entryDate: Today, supersedes: original);
        (await ReportAsync(correction)).ShouldBe(ReportOutcome.Sent);

        var attachment = App.Delivery.Sent[^1].Attachment;
        var s = ReportStrings.Serbian;

        PdfText.Contains(
                attachment,
                string.Format(
                    s.NumberCulture, s.CorrectionOfUnsentRecord, s.FormatDate(Yesterday)))
            .ShouldBeTrue(PdfText.Of(attachment));
    }

    [Fact]
    public async Task A_correction_of_a_correction_names_its_immediate_predecessor()
    {
        // Chains are deliberate (EntrySupersedesTests): a correction can itself be wrong. The
        // document to name is the one the client last received — walking to the head of the chain
        // would name a report two revisions old and hide the one in his inbox.
        var first = await GivenConfirmedEntryAsync(entryDate: TwoDaysAgo);
        (await ReportAsync(first)).ShouldBe(ReportOutcome.Sent);

        var second = await GivenConfirmedEntryAsync(entryDate: Yesterday, supersedes: first);
        (await ReportAsync(second)).ShouldBe(ReportOutcome.Sent);

        var third = await GivenConfirmedEntryAsync(entryDate: Today, supersedes: second);
        (await ReportAsync(third)).ShouldBe(ReportOutcome.Sent);

        var attachment = App.Delivery.Sent[^1].Attachment;
        var s = ReportStrings.Serbian;

        PdfText.Contains(attachment, $"{s.Corrects} {s.FormatDate(Yesterday)}").ShouldBeTrue(
            "the immediate predecessor is the document the client is holding\n\n"
            + PdfText.Of(attachment));

        PdfText.Contains(attachment, s.FormatDate(TwoDaysAgo)).ShouldBeFalse(
            "the head of the chain is two revisions old and naming it would hide the real one");
    }

    [Fact]
    public async Task A_chain_over_one_work_day_never_claims_to_be_the_only_report_for_that_day()
    {
        // The D9 review's first gating find, from the wire. Three records of ONE work day: A went
        // out, B superseded A and the relay refused it, C supersedes B. C prints the unsent variant
        // — truthfully, B never left the building — and while that variant ended "ovo je jedini
        // izveštaj za taj dan", it said so with A's report for that same day already delivered.
        //
        // The date is deliberately the same on all three, which is what a correction is: another
        // record of one day of work. Nothing in the schema forbids it (there is no unique index on
        // (project_id, entry_date)) and `POST /entries` does not either.
        var day = Yesterday;

        var a = await GivenConfirmedEntryAsync(entryDate: day);
        (await ReportAsync(a)).ShouldBe(ReportOutcome.Sent);

        var b = await GivenConfirmedEntryAsync(entryDate: day, supersedes: a);
        App.Delivery.Fails = () => new ReportDeliveryException(
            "fake-smtp", "the relay refused", ReportDeliveryFailureKind.Rejected);
        (await ReportAsync(b)).ShouldBe(ReportOutcome.Failed);
        App.Delivery.Fails = null;

        (await LoadReportAsync(b))!.SentAt.ShouldBeNull("the arrange did deliver B after all");

        var c = await GivenConfirmedEntryAsync(entryDate: day, supersedes: b);
        (await ReportAsync(c)).ShouldBe(ReportOutcome.Sent);

        // Two documents for that one work day are now in the client's inbox, which is precisely
        // what the removed clause denied.
        App.Delivery.Sent.Count.ShouldBe(2, "A and C both went out, for the same work day");

        var attachment = App.Delivery.Sent[^1].Attachment;
        var s = ReportStrings.Serbian;
        var text = PdfText.Of(attachment);

        // The fact it may state, and does: B never reached him.
        PdfText.Contains(
                attachment,
                string.Format(s.NumberCulture, s.CorrectionOfUnsentRecord, s.FormatDate(day)))
            .ShouldBeTrue(text);

        foreach (var claim in ReportCorrectionTests.ExclusivityClaims("sr"))
        {
            PdfText.Contains(attachment, claim).ShouldBeFalse(
                $"A's report for {s.FormatDate(day)} is already with the client, so \"{claim}\" "
                + "would be a false statement on an evidence document\n\n" + text);
        }
    }

    [Fact]
    public async Task A_delivered_report_on_an_unsealed_entry_is_still_named_as_sent()
    {
        // The D9 review's second gating find. `ReadCorrectionAsync` reads `report.sent_at` and not
        // `entry.reported_at`, deliberately — and mutation M5 (swapping the two) left all six tests
        // in this class green, because every other arrangement has both columns set or both null.
        //
        // This is the one shape where they disagree, and it is not exotic: `superseded_after_send`
        // is a document the relay took followed by an entry that changed, so the entry is left
        // `confirmed` and unsealed on purpose — and the remedy the server itself asks for is a new
        // entry superseding it, which is exactly this correction. Keying on the seal would print
        // "never sent" over a report the client is holding.
        var original = await GivenConfirmedEntryAsync(entryDate: Yesterday);

        var raced = DefaultCorrected();
        raced["notes"] = "Ispravka koja je stigla dok je izveštaj već bio kod relaya.";

        App.Delivery.WhileSending = async () =>
        {
            App.Delivery.WhileSending = null;
            await using var db = App.CreateDbContext(TestIds.CompanyA);
            await db.Entries.Where(e => e.Id == original)
                .ExecuteUpdateAsync(
                    u => u.SetProperty(e => e.Corrected, raced.ToJsonString()), Ct);
        };

        (await ReportAsync(original)).ShouldBe(ReportOutcome.Sent);

        var superseded = (await LoadEntryAsync(original))!;
        superseded.Status.ShouldBe(EntryStatus.Confirmed);
        superseded.ReportedAt.ShouldBeNull(
            "the arrange did not reach superseded_after_send, so it proves nothing about M5");
        ReportFailure.CodeOf(superseded.FailureReason)
            .ShouldBe(ReportFailure.SupersededAfterSend);

        var sentAt = (await LoadReportAsync(original))!.SentAt.ShouldNotBeNull(
            "the relay did take that message; that is the whole point of this state");

        var correction = await GivenConfirmedEntryAsync(
            entryDate: Today, supersedes: original);

        (await ReportAsync(correction)).ShouldBe(ReportOutcome.Sent);

        var attachment = App.Delivery.Sent[^1].Attachment;
        var s = ReportStrings.Serbian;
        var text = PdfText.Of(attachment);

        PdfText.Contains(
                attachment,
                string.Format(
                    s.NumberCulture,
                    s.CorrectionOfSentReport,
                    s.FormatDate(Yesterday),
                    s.FormatTimestamp(
                        UtcStamp.Of(sentAt),
                        ReportTimeZone.Resolve(ReportTimeZone.Default))))
            .ShouldBeTrue(
                "the entry is unsealed but the document went out; the client is holding it\n\n"
                + text);

        PdfText.Contains(
                attachment,
                string.Format(
                    s.NumberCulture, s.CorrectionOfUnsentRecord, s.FormatDate(Yesterday)))
            .ShouldBeFalse(
                "sending him hunting for a report he already has is the worst thing this line "
                + "could say\n\n" + text);
    }

    [Fact]
    public async Task An_ordinary_reported_day_prints_no_correction_at_all()
    {
        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var attachment = App.Delivery.LastSent.ShouldNotBeNull().Attachment;
        var s = ReportStrings.Serbian;

        PdfText.Contains(attachment, s.CorrectionHeading.ToUpperInvariant()).ShouldBeFalse(
            PdfText.Of(attachment));
        PdfText.Contains(attachment, s.Corrects).ShouldBeFalse();
    }

    [Fact]
    public async Task Reporting_a_correction_rewrites_nothing_about_the_report_it_supersedes()
    {
        // Reports are sealed and immutable: the new document names its predecessor, the old one is
        // never touched. The client's copy of it is out of reach anyway — this is about the row
        // that proves what was sent.
        var original = await GivenConfirmedEntryAsync(entryDate: Yesterday);
        (await ReportAsync(original)).ShouldBe(ReportOutcome.Sent);

        var before = (await LoadReportAsync(original))!;

        var correction = await GivenConfirmedEntryAsync(entryDate: Today, supersedes: original);
        (await ReportAsync(correction)).ShouldBe(ReportOutcome.Sent);

        var after = (await LoadReportAsync(original))!;

        after.Status.ShouldBe(before.Status);
        after.SentAt.ShouldBe(before.SentAt);
        after.PdfObjectKey.ShouldBe(before.PdfObjectKey);
        after.PdfSha256.ShouldBe(before.PdfSha256);
        after.DeliveryDetail.ShouldBe(before.DeliveryDetail);

        // And the superseded entry is still sealed exactly as it was.
        var entry = (await LoadEntryAsync(original))!;
        entry.Status.ShouldBe(EntryStatus.Reported);
        entry.SupersedesEntryId.ShouldBeNull("the link points backwards, never forwards");
    }

    [Fact]
    public async Task A_correction_whose_predecessor_belongs_to_another_company_names_nothing()
    {
        // Unreachable through the API — `POST /entries` refuses a link to any entry outside this
        // site — so it is arranged the only way it can exist: a row written past the endpoint. The
        // report must still go out, and it must not name a day it cannot see. It is the one case
        // where this page is as weak as it was before the increment, and it is here so that
        // "loudly nothing" is a tested answer rather than a hope.
        var foreign = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            foreign, TestIds.CompanyB, TestIds.ProjectB1, EntryStatus.Received));

        var correction = await GivenConfirmedEntryAsync(entryDate: Today);
        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var row = await db.Entries.FirstAsync(e => e.Id == correction, Ct);
            row.SupersedesEntryId = foreign;
            await db.SaveChangesAsync(Ct);
        }

        (await ReportAsync(correction)).ShouldBe(ReportOutcome.Sent);

        var attachment = App.Delivery.LastSent.ShouldNotBeNull().Attachment;

        PdfText.Contains(attachment, ReportStrings.Serbian.CorrectionHeading.ToUpperInvariant())
            .ShouldBeFalse("a page must not announce a correction it cannot describe");
    }
}
