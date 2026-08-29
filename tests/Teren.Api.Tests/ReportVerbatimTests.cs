using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The prose variant of the daily report: the day as the foreman's own words rather than as a
/// structured day (founder, 2026-08-29, PROJECT.md §11).
/// <para>
/// **Why it exists.** Extraction can be down — an expired API key was enough — and the entry
/// then parks with a perfectly good transcript and no structure. The alternative for the foreman
/// is typing his whole day by hand, which is the work the product exists to remove, so the
/// confirmation screen lets him approve his own transcript as the record and sends
/// <c>described_verbatim</c> inside <c>corrected</c> with the transcript in <c>notes</c>.
/// </para>
/// <para>
/// Two claims carry the increment and each has a test here whose failure is the point.
/// **One:** such an entry renders the transcript. Without it the existing template lays out an
/// empty structured day — no work, no materials — on a document a client reads, which is worse
/// than useless. **Two:** a reader can tell his words from extracted data, so nothing on the
/// page lets "the system understood five work items" pass for "the foreman described his day
/// like this" — otherwise nothing creates pressure to notice that extraction is broken.
/// </para>
/// <para>
/// The Serbian and English copy is drafted by Claude and **owes the founder's native review**.
/// </para>
/// </summary>
public sealed class ReportVerbatimTests : IDisposable
{
    /// <summary>What a foreman actually says into a phone at the end of a day, transcribed:
    /// continuous speech, no headings, and Serbian diacritics throughout.</summary>
    private const string Transcript =
        "Danas smo radili razvod tople i hladne vode na drugom spratu, zapadno krilo. "
        + "Postavili smo oko četrdeset metara PPR cevi dvadeset pet. Bila su tri "
        + "vodoinstalatera. Čeka se štemovanje od električara da bismo mogli dalje. Đubre je "
        + "odneto sa sprata. Sutra nastavljamo na trećem spratu.";

    private static readonly QuestPdfReportRenderer Renderer = new(
        Options.Create(new ReportingOptions()),
        NullLogger<QuestPdfReportRenderer>.Instance);

    private readonly string _workspace = Path.Combine(
        Path.GetTempPath(), "teren-verbatim-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_workspace))
        {
            Directory.Delete(_workspace, recursive: true);
        }
    }

    // ----------------------------------------------- claim one: his words are on the page

    [Fact]
    public void A_verbatim_day_puts_the_transcript_on_the_page()
    {
        // The headline. Break the renderer's verbatim branch and this is what fails: the client
        // receives a page with a letterhead and nothing under it.
        var pdf = Renderer.RenderDaily(Verbatim("sr"));

        PdfText.Contains(pdf, Transcript).ShouldBeTrue(
            "the foreman's own words are the whole description of the day on a verbatim "
            + "report; without them the client gets an empty page\n\n" + PdfText.Of(pdf));
    }

    [Fact]
    public void A_verbatim_day_is_not_rendered_as_an_empty_structured_day()
    {
        // The failure this variant exists to prevent, asserted directly rather than implied. The
        // structured headings must be absent — a page that prints "IZVEDENI RADOVI" over nothing
        // tells a client the day was documented and that no work was done.
        var pdf = Renderer.RenderDaily(Verbatim("sr"));
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.WorkDone.ToUpperInvariant()).ShouldBeFalse(
            "an empty work section must not head a verbatim report");
        PdfText.Contains(pdf, s.Materials.ToUpperInvariant()).ShouldBeFalse();
        PdfText.Contains(pdf, s.Workforce.ToUpperInvariant()).ShouldBeFalse();
    }

    [Fact]
    public void The_transcript_is_printed_once_and_not_again_under_notes()
    {
        // `notes` is where the transcript rides, so the ordinary notes section would print the
        // same words a second time — the second time with no statement of where they came from,
        // which is the exact confusion this variant exists to remove.
        var pdf = Renderer.RenderDaily(Verbatim("sr"));

        PdfText.Contains(pdf, ReportStrings.Serbian.Notes.ToUpperInvariant()).ShouldBeFalse(
            "the transcript already has its own heading; a second copy under Napomene is noise");
    }

    // ----------------------------------------- claim two: marked as his words, not as data

    [Theory]
    [InlineData("sr")]
    [InlineData("en")]
    public void The_page_says_plainly_that_these_are_his_own_words_and_not_extracted_data(
        string language)
    {
        var pdf = Renderer.RenderDaily(Verbatim(language));
        var s = ReportStrings.For(language);

        // The heading a reader meets first, the honesty line under it, and the same fact again
        // in the evidence block where someone checking the document's standing looks.
        PdfText.Contains(pdf, s.VerbatimDescription.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.VerbatimNote).ShouldBeTrue(
            "a reader must never mistake a verbatim day for a structured one\n\n"
            + PdfText.Of(pdf));
        PdfText.Contains(pdf, s.RecordKind).ShouldBeTrue();
        PdfText.Contains(pdf, s.RecordKindVerbatim).ShouldBeTrue();
    }

    [Fact]
    public void The_evidence_the_document_already_carried_is_untouched_by_the_prose_variant()
    {
        // "This changes the description of the day, nothing else." Photographs, the checksum
        // statement and the record block still apply exactly as before.
        var pdf = Renderer.RenderDaily(Verbatim("sr", photos: 2));
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.Photos.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.EvidenceNote).ShouldBeTrue();
        PdfText.Contains(pdf, s.RecordSection.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.CapturedAt).ShouldBeTrue();
    }

    // ------------------------------------ claim three: the ordinary report is untouched

    [Fact]
    public void A_normal_structured_entry_is_completely_unaffected()
    {
        // The other half of the increment, and the one nobody would notice breaking: a day the
        // model *did* structure must render exactly as it always has. Every marking that belongs
        // to the verbatim variant is absent, and the notes section is back where it was.
        var pdf = Renderer.RenderDaily(Structured("sr"));
        var s = ReportStrings.Serbian;

        PdfText.Contains(pdf, s.VerbatimDescription.ToUpperInvariant()).ShouldBeFalse(
            "a structured day must never be labelled as the foreman's unstructured words");
        PdfText.Contains(pdf, s.VerbatimNote).ShouldBeFalse();
        PdfText.Contains(pdf, s.RecordKindVerbatim).ShouldBeFalse();

        // …and everything a structured day always printed still prints.
        PdfText.Contains(pdf, s.WorkDone.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.Materials.ToUpperInvariant()).ShouldBeTrue();
        PdfText.Contains(pdf, s.Notes.ToUpperInvariant()).ShouldBeTrue(
            "notes belong under their own heading on a structured day");
        PdfText.Contains(pdf, "Sutra nastavak na trećem spratu.").ShouldBeTrue();
    }

    [Fact]
    public void The_two_variants_are_genuinely_different_documents()
    {
        // A renderer that read the flag and did nothing with it would pass every "is it a PDF"
        // test in the suite.
        Renderer.RenderDaily(Verbatim("sr")).ShouldNotBe(Renderer.RenderDaily(Structured("sr")));
    }

    // ------------------------------------------------------------------ reading the flag

    [Fact]
    public void The_flag_is_read_off_the_corrected_JSONB()
    {
        var content = ReportContentReader.Read(
            """
            {"schema_version":1,"described_verbatim":true,"work_done":[],"headcount":null,
             "materials":[],"blockers":[],"hidden_work":[],"notes":"Danas smo radili razvod."}
            """);

        content.DescribedVerbatim.ShouldBeTrue();
        content.HasVerbatimDescription.ShouldBeTrue();
        content.Notes.ShouldBe("Danas smo radili razvod.");
        content.IsEmpty.ShouldBeFalse("the transcript is what the client reads");
    }

    [Fact]
    public void An_ordinary_structure_carries_no_such_claim()
    {
        ReportContentReader.Read(
            """{"schema_version":1,"work_done":[],"notes":"Sve po planu."}""")
            .DescribedVerbatim.ShouldBeFalse();
    }

    [Theory]
    [InlineData("\"true\"")]   // a client that stringified a boolean
    [InlineData("1")]
    [InlineData("false")]
    [InlineData("null")]
    public void Only_a_real_JSON_true_makes_the_document_claim_a_verbatim_transcript(string value)
    {
        // Everything else on this page is read forgivingly, because a language model wrote it.
        // This key is read strictly: nothing writes it except the confirmation screen, and it
        // changes what the document claims about its own provenance. Guessing at a client's
        // intent would put a statement on an investor's PDF that nobody made.
        var json = "{\"schema_version\":1,\"described_verbatim\":" + value
            + ",\"notes\":\"nešto\"}";

        ReportContentReader.Read(json).DescribedVerbatim.ShouldBeFalse();
    }

    [Fact]
    public void The_flag_alone_does_not_rescue_a_day_with_nothing_in_it()
    {
        // A claim is not content. An entry flagged verbatim with a blank transcript must still
        // be refused as nothing-to-report, and must never announce a transcript it does not have.
        var content = ReportContentReader.Read(
            """{"schema_version":1,"described_verbatim":true,"work_done":[],"notes":"   "}""");

        content.DescribedVerbatim.ShouldBeTrue();
        content.HasVerbatimDescription.ShouldBeFalse();
        content.IsEmpty.ShouldBeTrue();
    }

    [Fact]
    public void A_flagged_day_with_photographs_but_no_words_announces_no_transcript()
    {
        // Reachable: `IsEmpty` lets photographs alone carry a report, so this page really can be
        // rendered. It must not print a heading and an honesty line over an empty rule.
        var content = ReportContent.Empty with { DescribedVerbatim = true };
        var pdf = Renderer.RenderDaily(Verbatim("sr", photos: 2) with { Content = content });

        PdfText.Contains(pdf, ReportStrings.Serbian.VerbatimDescription.ToUpperInvariant())
            .ShouldBeFalse("there is no transcript to introduce");
        PdfText.Contains(pdf, ReportStrings.Serbian.RecordKindVerbatim).ShouldBeFalse();
    }

    [Fact]
    public void A_transcript_that_arrives_in_several_utterances_keeps_its_paragraphs()
    {
        // Providers differ: one returns an unbroken run, another segments by utterance. Both
        // have to read as prose on the page.
        var segmented = "Danas smo radili razvod vode.\nČeka se štemovanje.\n\nSutra nastavak.";
        var pdf = Renderer.RenderDaily(Verbatim("sr", transcript: segmented));

        PdfText.Contains(pdf, "Danas smo radili razvod vode.").ShouldBeTrue();
        PdfText.Contains(pdf, "Čeka se štemovanje.").ShouldBeTrue();
        PdfText.Contains(pdf, "Sutra nastavak.").ShouldBeTrue();
    }

    // ------------------------------------------------------------------ helpers

    private DailyReport Verbatim(string language, int photos = 0, string? transcript = null) =>
        Report(
            language,
            ReportContent.Empty with
            {
                Notes = transcript ?? Transcript,
                DescribedVerbatim = true,
            },
            photos);

    private DailyReport Structured(string language) =>
        Report(
            language,
            new ReportContent(
                [new WorkDoneItem(
                    "Razvod tople i hladne vode", "zapadno krilo, 2. sprat",
                    new ReportQuantity(40, "m"))],
                new ReportHeadcount(3, [new ReportRole("vodoinstalater", 3)]),
                [new MaterialItem("PPR cev 25mm", new ReportQuantity(40, "m"), true)],
                [new BlockerItem("čeka se štemovanje", "električari")],
                [new HiddenWorkItem("cevi u zidu pre zatvaranja", [])],
                "Sutra nastavak na trećem spratu."),
            photos: 0);

    private DailyReport Report(string language, ReportContent content, int photos)
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
                Guid.NewGuid(), path, new string('a', 64), DateTimeOffset.UtcNow.AddHours(-3)));
        }

        return new DailyReport(
            "Vodoinstal Petrović d.o.o.",
            "Stambena zgrada Vojvode Stepe 212",
            "Vojvode Stepe 212, Voždovac, Beograd",
            new DateOnly(2026, 8, 29),
            language,
            ReportTimeZone.Default,
            content,
            images,
            new ReportProvenance(
                Guid.NewGuid(),
                new DateTimeOffset(2026, 8, 29, 14, 32, 0, TimeSpan.Zero),
                new DateTimeOffset(2026, 8, 29, 14, 33, 0, TimeSpan.Zero),
                new DateTimeOffset(2026, 8, 29, 14, 35, 0, TimeSpan.Zero)));
    }
}

/// <summary>
/// The same variant, but from the wire: what the confirmation screen actually sends, through
/// <c>/confirm</c>, through the report pass, into the PDF a relay was handed.
/// <para>
/// The render tests above prove the layout. These prove the **contract** — that
/// <c>described_verbatim</c> survives validation, survives Postgres, and is still there when the
/// renderer asks. Any one of those three quietly dropping the key gives a client an empty page,
/// and no layout test would see it.
/// </para>
/// </summary>
public sealed class ReportVerbatimEndToEndTests(TerenTestApp app) : ApiTestBase(app)
{
    private const string Transcript =
        "Danas smo radili razvod tople i hladne vode na drugom spratu. Čeka se štemovanje od "
        + "električara. Sutra nastavljamo na trećem spratu.";

    /// <summary>Exactly the pinned contract: schema v1's keys, the flag at the top level, the
    /// transcript verbatim in <c>notes</c>, every structured section empty.</summary>
    private static JsonObject VerbatimCorrected(string transcript = Transcript) => new()
    {
        ["schema_version"] = 1,
        ["described_verbatim"] = true,
        ["work_done"] = new JsonArray(),
        ["headcount"] = null,
        ["materials"] = new JsonArray(),
        ["blockers"] = new JsonArray(),
        ["hidden_work"] = new JsonArray(),
        ["notes"] = transcript,
    };

    [Fact]
    public async Task Confirm_accepts_the_flag_and_stores_it_rather_than_stripping_it()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        await ProcessAsync(entryId);

        var response = await ConfirmAsync(entryId, VerbatimCorrected());

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        // Stored, not stripped. The report generator keys on it, so a validator that silently
        // dropped an unrecognised top-level key would leave the client with an empty page and
        // the server with a 200.
        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.Corrected.ShouldNotBeNull();
        ReportContentReader.Read(entry.Corrected).DescribedVerbatim.ShouldBeTrue();

        // The transcript column is untouched by any of this — it is one third of the eval triple
        // (§9.3), and `corrected` recording approval-as-is is what keeps that signal honest.
        entry.RawTranscript.ShouldNotBeNull();
    }

    [Fact]
    public async Task The_foremans_own_words_reach_the_pdf_the_relay_was_handed()
    {
        var entryId = await GivenConfirmedEntryAsync(
            photos: 1, corrected: VerbatimCorrected());

        var outcome = await ReportAsync(entryId);

        outcome.ShouldBe(ReportOutcome.Sent);

        // Not the model the renderer was handed — the bytes that left the building.
        var attachment = App.Delivery.LastSent.ShouldNotBeNull().Attachment;

        PdfText.Contains(attachment, Transcript).ShouldBeTrue(
            "the day a client receives is the foreman's own words\n\n" + PdfText.Of(attachment));
        PdfText.Contains(attachment, ReportStrings.Serbian.VerbatimNote).ShouldBeTrue(
            "and it must be marked as his words rather than as extracted data");

        // A rendering difference, not a pipeline difference: the entry is sealed exactly as any
        // other reported entry is.
        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Reported);
        entry.ReportedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task A_verbatim_confirmation_with_no_words_is_refused_rather_than_sent_empty()
    {
        // The flag is a claim, not content. Nothing about this variant weakens the refusal that
        // keeps an empty page with a letterhead out of an investor's inbox.
        var entryId = await GivenConfirmedEntryAsync(
            corrected: VerbatimCorrected(transcript: "   "));

        var outcome = await ReportAsync(entryId);

        outcome.ShouldBe(ReportOutcome.Failed);
        App.Delivery.Sent.Count.ShouldBe(0);

        var entry = (await LoadEntryAsync(entryId))!;
        entry.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ReportedAt.ShouldBeNull();
        entry.FailureReason.ShouldNotBeNull();
    }
}
