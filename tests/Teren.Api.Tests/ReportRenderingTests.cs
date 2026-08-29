using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The PDF itself, rendered by the real QuestPDF renderer with no database and no host.
/// <para>
/// This document is the only part of Teren the contractor's client ever sees and the reason the
/// buyer pays (PROJECT.md §2), so it gets tested as a deliverable rather than as a byproduct.
/// The headline case is the Serbian one: the renderer runs with
/// <c>QuestPDF.Settings.CheckIfAllTextGlyphsAreAvailable</c> turned on permanently, so a font
/// that cannot draw č, ć, š, ž or đ throws here instead of putting placeholder boxes in a PDF
/// that has already been emailed to an investor.
/// </para>
/// </summary>
public sealed class ReportRenderingTests : IDisposable
{
    private readonly string _workspace = Path.Combine(
        Path.GetTempPath(), "teren-render-tests", Guid.NewGuid().ToString("N"));

    private static readonly QuestPdfReportRenderer Renderer = new(
        Options.Create(new ReportingOptions()),
        NullLogger<QuestPdfReportRenderer>.Instance);

    /// <summary>
    /// Every Serbian Latin letter that carries a diacritic, upper and lower case, plus the trade
    /// vocabulary the product actually handles. If the font is missing one glyph, it is one of
    /// these.
    /// </summary>
    private const string Diacritics = "čćšžđ ČĆŠŽĐ — Vodoinstal Petrović d.o.o., štemovanje, "
        + "vodokotlić, đubre, tlačna proba, Miloš, Đorđe, Žarko, Ćuprija";

    public void Dispose()
    {
        if (Directory.Exists(_workspace))
        {
            Directory.Delete(_workspace, recursive: true);
        }
    }

    // ------------------------------------------------------------ the Serbian guarantee

    [Fact]
    public void A_Serbian_report_renders_every_diacritic_rather_than_a_placeholder_box()
    {
        // Not a smoke test. QuestPDF is configured to throw when the font cannot draw a
        // character, so this assertion is "the shipped font covers Serbian Latin" — the whole of
        // ARCHITECTURE §14 decision 6, checked mechanically. Point the renderer at a font
        // without these glyphs and this is the test that fails.
        var pdf = Renderer.RenderDaily(Report("sr", Diacritics, photos: 2));

        pdf.ShouldNotBeEmpty();
        IsPdf(pdf).ShouldBeTrue("the renderer must produce a PDF, not bytes that merely exist");
    }

    [Fact]
    public void A_character_the_font_cannot_draw_is_refused_rather_than_printed_as_a_box()
    {
        // The positive control for the test above, and the reason it means anything: it passes
        // because Lato really does carry č/ć/š/ž/đ, not because the glyph check is inert. Turn
        // QuestPDF.Settings.CheckIfAllTextGlyphsAreAvailable off — it defaults to on only when a
        // debugger is attached, which is to say off in CI and off in production — and this is
        // what stops failing, after which a missing glyph becomes a placeholder box in a PDF
        // already sitting in an investor's inbox.
        const string undrawable = "\uE000";  // private use area: no font assigns it

        Should.Throw<Exception>(() => Renderer.RenderDaily(Report("sr", undrawable)));
    }

    [Fact]
    public void An_English_report_comes_out_of_the_same_machinery()
    {
        var pdf = Renderer.RenderDaily(Report("en", "Hot and cold water runs, second floor"));

        IsPdf(pdf).ShouldBeTrue();
    }

    [Fact]
    public void The_two_languages_produce_genuinely_different_documents()
    {
        // The chrome differs — headings, the record block, the page footer — so the same content
        // in two languages cannot render to the same bytes. A renderer that ignored
        // DailyReport.Language would fail here.
        var serbian = Renderer.RenderDaily(Report("sr", "Razvod vode"));
        var english = Renderer.RenderDaily(Report("en", "Razvod vode"));

        serbian.ShouldNotBe(english);
    }

    // ------------------------------------------------------------ content on the page

    [Fact]
    public void Photographs_make_it_into_the_document()
    {
        var without = Renderer.RenderDaily(Report("sr", "Razvod vode"));
        var with = Renderer.RenderDaily(Report("sr", "Razvod vode", photos: 3));

        // Three embedded images are worth thousands of bytes; a renderer that quietly skipped
        // them would produce a document the same size as one with none.
        with.Length.ShouldBeGreaterThan(without.Length + 2000);
    }

    [Fact]
    public void A_report_with_nothing_but_photographs_still_lays_out()
    {
        // Reachable in production: an entry whose extraction produced nothing but which carries
        // the photographs that are the point of it. The pass only refuses when *both* are empty.
        var pdf = Renderer.RenderDaily(
            Report("sr", description: null, photos: 2));

        IsPdf(pdf).ShouldBeTrue();
    }

    [Fact]
    public void Twenty_photographs_stay_within_a_size_a_mail_relay_will_carry()
    {
        // MediaPolicy caps an entry at 20 photographs, so this is the worst case that can exist.
        // Reporting:PhotoRasterDpi is the knob that keeps it sane; raising it far enough to make
        // an attachment relays refuse is what this number catches.
        var pdf = Renderer.RenderDaily(Report("sr", "Razvod vode", photos: 20));

        pdf.Length.ShouldBeLessThan(
            15 * 1024 * 1024,
            "twenty photographs must not produce an attachment a mail relay will bounce");
    }

    // ------------------------------------------------------------ masthead and brand

    [Fact]
    public void A_project_with_no_address_still_lays_out()
    {
        // Reachable: address is nullable, and the seeder's own projects are the only ones that
        // certainly have one. It matters more since the masthead gained the brand line — the
        // right column now has three rows and the left has two without an address — and since
        // the record card falls back to the project name where the address used to be.
        var pdf = Renderer.RenderDaily(Report("sr", "Razvod vode") with { ProjectAddress = null });

        IsPdf(pdf).ShouldBeTrue();
    }

    [Fact]
    public void The_wordmark_is_what_renders_when_no_logo_file_is_configured()
    {
        // The repo carries no image asset and none is expected, so this is the shipping path.
        var pdf = Renderer.RenderDaily(Report("sr", "Razvod vode"));

        IsPdf(pdf).ShouldBeTrue();
    }

    [Fact]
    public void A_logo_file_swaps_in_through_one_setting_and_the_layout_still_holds()
    {
        // The founder's requirement: swapping in a real logo is one config line and no layout
        // change. The brand slot is a fixed height, so the image takes exactly the space the
        // wordmark took. If that ever stops being true, QuestPDF throws a layout exception here
        // rather than silently pushing the accent rule down the page.
        Directory.CreateDirectory(_workspace);
        var logo = Path.Combine(_workspace, "logo.png");
        File.WriteAllBytes(logo, TestImage.Png(7, 320, 96));

        var branded = new QuestPdfReportRenderer(
            Options.Create(new ReportingOptions { BrandLogoPath = logo }),
            NullLogger<QuestPdfReportRenderer>.Instance);

        IsPdf(branded.RenderDaily(Report("sr", "Razvod vode"))).ShouldBeTrue();
    }

    [Fact]
    public void A_configured_logo_that_does_not_exist_falls_back_rather_than_failing_the_report()
    {
        // A brand mark is the one thing on this page carrying no evidence. Refusing to send a
        // client his site diary over a mistyped image path would trade something that matters for
        // something that does not, so this warns at construction and renders the wordmark.
        var misconfigured = new QuestPdfReportRenderer(
            Options.Create(new ReportingOptions
            {
                BrandLogoPath = Path.Combine(_workspace, "does-not-exist.png"),
            }),
            NullLogger<QuestPdfReportRenderer>.Instance);

        IsPdf(misconfigured.RenderDaily(Report("sr", "Razvod vode"))).ShouldBeTrue();
    }

    // ------------------------------------------------------------ helpers

    private static bool IsPdf(byte[] bytes) =>
        bytes.Length > 5 && Encoding.ASCII.GetString(bytes, 0, 5) == "%PDF-";

    private DailyReport Report(
        string language,
        string? description,
        int photos = 0,
        string timeZoneId = ReportTimeZone.Default)
    {
        var content = description is null
            ? ReportContent.Empty
            : new ReportContent(
                [new WorkDoneItem(description, "zapadno krilo, 2. sprat", new ReportQuantity(40, "m"))],
                new ReportHeadcount(3, [new ReportRole("vodoinstalater", 3)]),
                [new MaterialItem("PPR cev 25mm", new ReportQuantity(40, "m"), true),
                 new MaterialItem("ugradni vodokotlić Geberit Duofix", new ReportQuantity(6, "kom"), false),
                 new MaterialItem("kuglasti ventil 1\"", null, null)],
                [new BlockerItem("čeka se štemovanje", "električari")],
                [new HiddenWorkItem("cevi u zidu pre zatvaranja", [])],
                "Sutra nastavak na trećem spratu. Đubre odneto.");

        Directory.CreateDirectory(_workspace);

        var images = new List<ReportPhoto>(photos);
        for (var index = 0; index < photos; index++)
        {
            var path = Path.Combine(_workspace, $"{language}-{index}.png");
            if (!File.Exists(path))
            {
                File.WriteAllBytes(path, TestImage.Png(index, 1600, 1200));
            }

            images.Add(new ReportPhoto(
                Guid.NewGuid(),
                path,
                new string('a', 64),
                DateTimeOffset.UtcNow.AddHours(-3)));
        }

        return new DailyReport(
            "Vodoinstal Petrović d.o.o.",
            "Stambena zgrada Vojvode Stepe 212",
            "Vojvode Stepe 212, Voždovac, Beograd",
            new DateOnly(2026, 8, 29),
            language,
            timeZoneId,
            content,
            images,
            new ReportProvenance(
                Guid.NewGuid(),
                DateTimeOffset.UtcNow.AddHours(-4),
                DateTimeOffset.UtcNow.AddHours(-3),
                DateTimeOffset.UtcNow));
    }
}
