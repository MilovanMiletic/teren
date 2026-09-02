using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The safety net under B6's enqueue path, and the deliberate limits on it.
/// <para>
/// Two duties, and the second one's <em>restraint</em> is the interesting part. A report claimed
/// for sending whose worker never came back is marked failed and **left there**: SMTP hands back
/// no delivery telemetry (ARCHITECTURE §10), so the server genuinely cannot say whether the
/// relay took the message, and neither guess is safe to make on a client's behalf.
/// </para>
/// </summary>
public sealed class ReportSweepTests(TerenTestApp app) : ApiTestBase(app)
{
    private FakeReportDelivery Delivery => App.Delivery;

    // ---------------------------------------------------------------- what was never queued

    [Fact]
    public async Task A_confirmed_entry_whose_enqueue_was_lost_is_found_by_the_sweep()
    {
        var entryId = await GivenConfirmedEntryAsync();

        // The enqueue happened at /confirm; pretend the process died before Hangfire saw it.
        App.Pipeline.Reset();

        var result = await SweepAsync();

        result.ReportsQueued.ShouldBe(1);
        App.Pipeline.Reports.ShouldContain((entryId, TestIds.CompanyA));
    }

    [Fact]
    public async Task A_reported_entry_is_never_queued_again()
    {
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        App.Pipeline.Reset();

        (await SweepAsync()).ReportsQueued.ShouldBe(0);
        App.Pipeline.Reports.ShouldBeEmpty();
    }

    [Fact]
    public async Task An_entry_that_already_failed_with_a_reason_is_not_retried_every_minute()
    {
        // The line B4 drew for needs_review, drawn again here: an entry that keeps being retried
        // and keeps dying is indistinguishable from an entry that was lost. A project with no
        // recipients does not get better by being rendered once a minute forever.
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.Recipients = "[]");

        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Failed);

        App.Pipeline.Reset();

        (await SweepAsync()).ReportsQueued.ShouldBe(0);
        App.Pipeline.Reports.ShouldBeEmpty();
    }

    [Fact]
    public async Task Fixing_the_cause_and_confirming_again_makes_the_entry_eligible_once_more()
    {
        await UpdateProjectAsync(TestIds.ProjectA1, p => p.Recipients = "[]");

        var entryId = await GivenConfirmedEntryAsync();
        await ReportAsync(entryId);

        // The founder adds a recipient and the foreman confirms again — which is the documented
        // retry path, because /confirm clears failure_reason.
        await UpdateProjectAsync(
            TestIds.ProjectA1, p => p.Recipients = TerenTestApp.OneRecipient);
        await ConfirmAsync(entryId, DefaultCorrected());

        App.Pipeline.Reset();

        (await SweepAsync()).ReportsQueued.ShouldBe(1);
        App.Pipeline.Reports.ShouldContain((entryId, TestIds.CompanyA));
    }

    [Fact]
    public async Task A_report_the_relay_took_but_that_was_never_sealed_is_found_by_the_sweep()
    {
        // The crash between "the row says sent" and "the entry says reported". Nothing else in
        // the system looks at that state: FailAbandonedReportsAsync only knows about `sending`,
        // and until this predicate included `sent` the entry matched nothing at all — the client
        // holding a report while the contractor's own archive says the day was never reported,
        // silently and permanently.
        //
        // EntryReporter has always had the recovery (seal, never re-send) and a test proving it,
        // but that test called the pass by hand. This one arranges the state and lets the
        // production sweep find it, which is the part that was missing.
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

        App.Pipeline.Reset();
        Delivery.Reset();

        var result = await SweepAsync();

        result.ReportsQueued.ShouldBe(1, "nothing else would ever queue this entry again");
        App.Pipeline.Reports.ShouldContain((entryId, TestIds.CompanyA));

        // And the pass the sweep queued finishes the job rather than repeating it.
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        Delivery.Sent.ShouldBeEmpty("the relay already has this report");

        var sealedEntry = (await LoadEntryAsync(entryId))!;
        sealedEntry.Status.ShouldBe(EntryStatus.Reported);
        sealedEntry.ReportedAt.ShouldNotBeNull();

        // Sealed, so the next sweep has nothing left to find.
        App.Pipeline.Reset();
        (await SweepAsync()).ReportsQueued.ShouldBe(0);
    }

    [Fact]
    public async Task An_entry_still_waiting_for_its_human_is_not_swept_into_a_report()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        await ProcessAsync(entryId);

        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.AwaitingConfirmation);

        App.Pipeline.Reset();

        (await SweepAsync()).ReportsQueued.ShouldBe(0);
    }

    // ---------------------------------------------------------------- what was abandoned

    [Fact]
    public async Task A_send_abandoned_mid_pass_is_made_visible_and_is_never_repeated_by_itself()
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

        // Older than Reporting:StaleAfter — the worker is not coming back.
        await SetReportAttemptStartedAsync(reportId, DateTime.UtcNow.AddHours(-2));

        App.Pipeline.Reset();
        var result = await SweepAsync();

        result.ReportsFailed.ShouldBe(1);

        var report = (await LoadReportAsync(entryId)).ShouldNotBeNull();
        report.Status.ShouldBe(ReportStatus.Failed);
        report.SentAt.ShouldBeNull();
        report.AttemptStartedAt.ShouldBeNull();
        ReportFailure.CodeOf(report.FailureReason).ShouldBe(ReportFailure.ReportInterrupted);

        // The same reason where the foreman looks, and the entry is not sealed: the server does
        // not know whether the client has it, and it says so rather than guessing.
        var updated = (await LoadEntryAsync(entryId))!;
        updated.Status.ShouldBe(EntryStatus.Confirmed);
        updated.ReportedAt.ShouldBeNull();
        ReportFailure.CodeOf(updated.FailureReason).ShouldBe(ReportFailure.ReportInterrupted);

        // And crucially: it was not queued to be sent again.
        App.Pipeline.Reports.ShouldBeEmpty();
        Delivery.Sent.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_send_that_is_merely_slow_is_left_alone()
    {
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
            // Claimed a moment ago: well inside Reporting:StaleAfter.
            AttemptStartedAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow,
        });

        (await SweepAsync()).ReportsFailed.ShouldBe(0);

        (await LoadReportAsync(entryId))!.Status.ShouldBe(ReportStatus.Sending);
    }

    [Fact]
    public async Task A_report_the_relay_took_is_never_touched_by_the_sweep()
    {
        var entryId = await GivenConfirmedEntryAsync();
        (await ReportAsync(entryId)).ShouldBe(ReportOutcome.Sent);

        var result = await SweepAsync();

        result.ReportsFailed.ShouldBe(0);
        (await LoadReportAsync(entryId))!.Status.ShouldBe(ReportStatus.Sent);
    }

    // ---------------------------------------------------------------- the two pipelines coexist

    [Fact]
    public async Task One_sweep_serves_both_pipelines_without_confusing_them()
    {
        // An entry waiting for processing and an entry waiting for its report, in one pass. They
        // must land in different queues; a sweep that mixed them would send a report for an
        // entry nobody has confirmed.
        var uploaded = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(uploaded);

        var confirmed = await GivenConfirmedEntryAsync();

        App.Pipeline.Reset();
        var result = await SweepAsync();

        result.Enqueued.ShouldBe(1);
        result.ReportsQueued.ShouldBe(1);

        App.Pipeline.Enqueued.ShouldBe([(uploaded, TestIds.CompanyA)]);
        App.Pipeline.Reports.ShouldBe([(confirmed, TestIds.CompanyA)]);
    }

    // ------------------------------------------------------- what the scan costs

    [Fact]
    public async Task The_abandoned_report_scan_has_an_index_to_read()
    {
        // FailAbandonedReportsAsync runs `WHERE status = 'sending' AND attempt_started_at < …`
        // every minute for the life of the box, and `report` carried no index on either column —
        // so the one query in the product that runs unconditionally, for ever, was a sequential
        // scan over a table that only grows (a report row is never deleted).
        //
        // Partial rather than an index on `status`: after the first week almost every row is
        // `sent`, and an index Postgres declines to use is a write cost with no read benefit.
        var indexes = await ReportIndexesAsync();

        var definition = indexes
            .Where(i => i.Name == "ix_report_sending_attempt")
            .Select(i => i.Definition)
            .SingleOrDefault()
            .ShouldNotBeNull(
                "the sweeper's report scan has no index. It is not a slow query today — it is a "
                + "slow query in six months, on the one statement nothing ever stops running.");

        definition.ShouldContain("attempt_started_at", Case.Sensitive);
        definition.ShouldContain("status", Case.Sensitive);
        definition.ShouldContain("sending", Case.Sensitive);

        // Anti-vacuous: the reader itself works, and it is reading `report`.
        indexes.Select(i => i.Name).ShouldContain("ux_report_entry_id");
    }

    private async Task<List<(string Name, string Definition)>> ReportIndexesAsync()
    {
        await using var db = App.CreateDbContext(companyId: null);
        await using var command = db.Database.GetDbConnection().CreateCommand();

        await db.Database.OpenConnectionAsync(Ct);
        command.CommandText =
            "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'report'";

        var rows = new List<(string, string)>();
        await using var reader = await command.ExecuteReaderAsync(Ct);
        while (await reader.ReadAsync(Ct))
        {
            rows.Add((reader.GetString(0), reader.GetString(1)));
        }

        return rows;
    }
}
