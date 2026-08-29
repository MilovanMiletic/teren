using Teren.Api.Tests.Infrastructure;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The other half of <see cref="ReportLocalTimeTests"/>. That one proves the conversion is
/// arithmetically right; this one proves the report pass actually feeds it the **project's**
/// zone, and that a zone nobody can resolve stops the report instead of quietly printing UTC.
/// <para>
/// The two are separate because they fail for different reasons: a broken formatter is a bug in
/// one method, a broken hand-off is a bug in the wiring, and a test that covers both tells you
/// neither.
/// </para>
/// </summary>
public sealed class ReportProjectTimeZoneTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task The_report_is_rendered_in_the_project_s_zone()
    {
        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        App.Renderer.LastRendered.ShouldNotBeNull()
            .TimeZoneId.ShouldBe(ReportTimeZone.Default);
    }

    [Fact]
    public async Task A_project_in_another_zone_renders_in_that_zone()
    {
        // The reason time_zone is a column rather than a constant. Hard-code Europe/Belgrade in
        // the reporter and this is the test that fails; every other timestamp test still passes,
        // because they all happen to be Belgrade projects.
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.TimeZone = "Asia/Tokyo");

        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        App.Renderer.LastRendered.ShouldNotBeNull().TimeZoneId.ShouldBe("Asia/Tokyo");
    }

    [Fact]
    public async Task Every_project_gets_the_market_s_zone_without_anyone_setting_it()
    {
        // The column is NOT NULL with a default, so a project created by any path — the seeder,
        // a future admin screen, a hand-written INSERT — is reportable. A nullable column here
        // would mean a project that renders no timestamps at all.
        await using var db = App.CreateDbContext(TestIds.CompanyA);

        var zones = db.Projects.Select(p => p.TimeZone).ToList();

        zones.ShouldNotBeEmpty();
        zones.ShouldAllBe(zone => zone == ReportTimeZone.Default);
    }

    [Fact]
    public async Task An_unresolvable_project_zone_fails_the_report_visibly_and_sends_nothing()
    {
        // The honest failure the founder asked for: no report rather than a report whose
        // timestamps are wrong. A person fixes one column and confirms again.
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.TimeZone = "Europe/Belgrad");

        var entryId = await GivenConfirmedEntryAsync();

        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        var entry = (await LoadEntryAsync(entryId)).ShouldNotBeNull();
        entry.FailureReason.ShouldNotBeNull();
        entry.FailureReason.ShouldStartWith(ReportFailure.TimeZoneUnknown);
        entry.FailureReason.ShouldContain("Europe/Belgrad");

        // Nothing left the building, and the entry is still correctable.
        App.Delivery.Sent.ShouldBeEmpty();
        entry.ReportedAt.ShouldBeNull();
        entry.Status.ShouldBe(Teren.Core.Entities.EntryStatus.Confirmed);
    }
}
