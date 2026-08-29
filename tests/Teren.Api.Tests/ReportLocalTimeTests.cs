using System.Globalization;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// Timestamps on the report print in the **site's** local time (founder, 2026-08-29, PROJECT.md
/// §11), from a per-project IANA zone. UTC remains the storage format everywhere; this is a
/// rendering concern and nothing else.
/// <para>
/// The tests below pick their instants deliberately. A single date proves nothing: Belgrade is
/// UTC+1 in winter and UTC+2 in summer, so a conversion that silently returned UTC, or one that
/// added a fixed hour, passes half the year. Both halves are asserted, on the same instant of
/// day, against exact strings.
/// </para>
/// </summary>
public sealed class ReportLocalTimeTests
{
    /// <summary>12:47 UTC on an August day — Belgrade is on CEST (UTC+2).</summary>
    private static readonly DateTimeOffset SummerNoon =
        new(2026, 8, 29, 12, 47, 0, TimeSpan.Zero);

    /// <summary>The same wall-clock instant in January — Belgrade is on CET (UTC+1).</summary>
    private static readonly DateTimeOffset WinterNoon =
        new(2026, 1, 15, 12, 47, 0, TimeSpan.Zero);

    // ------------------------------------------------------- the zone resolves at all

    [Fact]
    public void The_default_zone_is_an_IANA_id_this_host_can_resolve()
    {
        // Not a tautology, and the reason it is a test rather than an assumption: .NET only
        // accepts IANA ids on Windows from 6.0 onwards, via ICU. A host built without ICU
        // (an invariant-globalization container is the realistic way to get one) resolves
        // nothing, and this is where that is discovered — not in an investor's PDF.
        var zone = ReportTimeZone.Resolve(ReportTimeZone.Default);

        zone.ShouldNotBeNull();
        zone.GetUtcOffset(SummerNoon).ShouldBe(TimeSpan.FromHours(2));
        zone.GetUtcOffset(WinterNoon).ShouldBe(TimeSpan.FromHours(1));
    }

    [Fact]
    public void A_Windows_zone_id_also_resolves_and_that_is_recorded_rather_than_assumed()
    {
        // Written because the first version of this suite asserted the opposite and failed.
        // .NET 8+ maps in **both** directions — IANA ids on Windows, Windows ids on Unix — so a
        // Windows id is not the cross-platform landmine it used to be, and nothing here rejects
        // one. IANA remains the convention (it is what `project.time_zone` defaults to and what
        // the docs specify) but that is a convention, not something this code enforces. Pinned as
        // a test so the next reader is not told a story the runtime contradicts.
        var windows = ReportTimeZone.Resolve("Central European Standard Time");

        windows.GetUtcOffset(SummerNoon).ShouldBe(TimeSpan.FromHours(2));
    }

    [Theory]
    [InlineData("Mars/Olympus_Mons")]
    [InlineData("Europe/Belgrad")]   // one letter short of the real id
    [InlineData("")]
    [InlineData("   ")]
    public void An_unresolvable_zone_throws_rather_than_falling_back_to_UTC(string id)
    {
        // The whole point of the type. Falling back to UTC would put a timestamp that is quietly
        // an hour or two wrong on a document a client relies on in a dispute — and unlike a
        // missing report, nobody ever notices a wrong hour.
        var thrown = Should.Throw<ReportTimeZoneException>(() => ReportTimeZone.Resolve(id));

        thrown.Message.ShouldContain(ReportTimeZone.Default, Case.Sensitive);
    }

    // ------------------------------------------------------- the conversion itself

    [Fact]
    public void A_UTC_instant_in_summer_prints_as_Belgrade_summer_time()
    {
        var zone = ReportTimeZone.Resolve(ReportTimeZone.Default);

        // 12:47 UTC is 14:47 in Belgrade in August. Return UTC unconverted and this says 12:47.
        ReportStrings.Serbian.FormatTimestamp(SummerNoon, zone)
            .ShouldBe("29.08.2026. 14:47 (UTC+2)");
    }

    [Fact]
    public void A_UTC_instant_in_winter_prints_as_Belgrade_winter_time()
    {
        var zone = ReportTimeZone.Resolve(ReportTimeZone.Default);

        // The control on the test above: one hour, not two, and the offset label follows. A
        // conversion hard-coded to +2 passes the summer case and fails here.
        ReportStrings.Serbian.FormatTimestamp(WinterNoon, zone)
            .ShouldBe("15.01.2026. 13:47 (UTC+1)");
    }

    [Fact]
    public void The_English_report_converts_identically_and_only_the_pattern_differs()
    {
        var zone = ReportTimeZone.Resolve(ReportTimeZone.Default);

        ReportStrings.English.FormatTimestamp(SummerNoon, zone)
            .ShouldBe("29/08/2026 14:47 (UTC+2)");
    }

    [Fact]
    public void A_project_in_another_country_prints_that_country_s_time()
    {
        // The reason the column exists rather than a constant: a contractor working across a
        // border gets his client's local time, not Belgrade's.
        var zone = ReportTimeZone.Resolve("Europe/London");

        ReportStrings.Serbian.FormatTimestamp(SummerNoon, zone)
            .ShouldBe("29.08.2026. 13:47 (UTC+1)");
    }

    [Fact]
    public void A_zone_on_a_half_hour_offset_prints_its_minutes()
    {
        // India is UTC+5:30 year round. The offset label drops ":00" for whole hours, so this is
        // the case that proves it does not drop real minutes with it.
        var zone = ReportTimeZone.Resolve("Asia/Kolkata");

        ReportStrings.Serbian.FormatTimestamp(SummerNoon, zone)
            .ShouldBe("29.08.2026. 18:17 (UTC+5:30)");
    }

    [Fact]
    public void A_UTC_project_says_UTC_rather_than_an_offset_of_zero()
    {
        var zone = ReportTimeZone.Resolve("UTC");

        ReportStrings.Serbian.FormatTimestamp(SummerNoon, zone)
            .ShouldBe("29.08.2026. 12:47 (UTC)");
    }

    // ------------------------------------------------------- the renderer honours it

    [Fact]
    public void The_renderer_refuses_a_document_whose_zone_cannot_be_resolved()
    {
        // It throws before laying anything out, so no half-built document escapes. The report
        // pass turns this into a visible time_zone_unknown — see ReportGenerationTests.
        var renderer = new QuestPdfReportRenderer(
            Options.Create(new ReportingOptions()),
            NullLogger<QuestPdfReportRenderer>.Instance);

        Should.Throw<ReportTimeZoneException>(
            () => renderer.RenderDaily(Minimal("Europe/Belgrad")));  // one letter short
    }

    [Fact]
    public void The_renderer_lays_out_a_document_whose_zone_resolves()
    {
        var renderer = new QuestPdfReportRenderer(
            Options.Create(new ReportingOptions()),
            NullLogger<QuestPdfReportRenderer>.Instance);

        var pdf = renderer.RenderDaily(Minimal(ReportTimeZone.Default));

        pdf.Length.ShouldBeGreaterThan(0);
    }

    private static DailyReport Minimal(string timeZoneId) => new(
        "Vodoinstal Petrović d.o.o.",
        "Stambena zgrada Vojvode Stepe 212",
        "Vojvode Stepe 212, Voždovac, Beograd",
        new DateOnly(2026, 8, 29),
        "sr",
        timeZoneId,
        new ReportContent(
            [new WorkDoneItem("Razvod vode", null, null)], null, [], [], [], null),
        [],
        new ReportProvenance(Guid.NewGuid(), SummerNoon, SummerNoon, SummerNoon));
}
