using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Entities;
using Teren.Core.Processing;
using Teren.Core.Reporting;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Reporting;

namespace Teren.Infrastructure.Processing;

/// <summary>
/// The safety net under both enqueue paths, and the reason a lost job is not a lost entry.
/// <para>
/// Four duties, one pass — the same two questions asked of the B4 processing pipeline and of the
/// B6 report pipeline: what was never queued, and what was claimed and abandoned.
/// </para>
/// <list type="number">
/// <item><b>Pick up what was never queued.</b> <c>/complete</c> enqueues, but an enqueue can be
/// lost — the process dies between the commit and the queue write, or Hangfire storage was
/// briefly unavailable. Anything matching the §6 pickup predicate and still sitting there gets
/// queued again; the processor's atomic claim makes a duplicate enqueue free.</item>
/// <item><b>Park what was abandoned.</b> An entry claimed for processing whose worker never came
/// back — almost always a deploy or a crash — is moved to <c>needs_review</c> once
/// <c>Pipeline:StaleProcessingAfter</c> has passed, with its transcript intact. It is a
/// deliberate choice to make that visible rather than to re-queue it silently: an entry that
/// keeps being retried and keeps dying is exactly the "silently retry forever" failure the
/// increment forbids, and a human can re-run it after the cause is fixed.</item>
/// </list>
/// <para>
/// The scan is the one query in the pipeline that crosses tenants, because "is any company's
/// entry stuck" is a system question, not a request. It is written as raw SQL over two id
/// columns rather than as <c>IgnoreQueryFilters()</c> over entities, deliberately: it cannot
/// return anyone's data, only work items, so nothing tenant-scoped can leak through it. The
/// per-entry work that follows runs inside <see cref="EntryProcessor"/> under a set
/// <see cref="TenantContext"/>, filtered exactly like a request.
/// </para>
/// </summary>
public sealed class PipelineSweeper(
    TerenDbContext db,
    TenantContext tenant,
    IPipelineQueue queue,
    IOptions<PipelineOptions> options,
    IOptions<ReportingOptions> reportingOptions,
    ILogger<PipelineSweeper> logger)
{
    private readonly PipelineOptions _options = options.Value;
    private readonly ReportingOptions _reporting = reportingOptions.Value;

    public async Task<SweepResult> SweepAsync(CancellationToken ct)
    {
        var enqueued = await EnqueuePendingAsync(ct);
        var parked = await ParkAbandonedAsync(ct);
        var reportsQueued = await EnqueuePendingReportsAsync(ct);
        var reportsFailed = await FailAbandonedReportsAsync(ct);

        if (enqueued > 0 || parked > 0 || reportsQueued > 0 || reportsFailed > 0)
        {
            logger.LogInformation(
                "Pipeline sweep: {Enqueued} entry(ies) queued, {Parked} abandoned entry(ies) "
                + "parked for review, {ReportsQueued} report(s) queued, {ReportsFailed} "
                + "abandoned report(s) marked failed.",
                enqueued, parked, reportsQueued, reportsFailed);
        }

        return new SweepResult(enqueued, parked, reportsQueued, reportsFailed);
    }

    /// <summary>
    /// ARCHITECTURE §6, verbatim: <c>status = received AND received_at IS NOT NULL</c>. Ordered
    /// by receipt so a backlog drains oldest-first — the foreman waiting longest is served first.
    /// </summary>
    private async Task<int> EnqueuePendingAsync(CancellationToken ct)
    {
        var work = await ScanAsync(
            """
            SELECT id, company_id FROM entry
            WHERE status = 'received' AND received_at IS NOT NULL
            ORDER BY received_at
            LIMIT @limit
            """,
            command => command.Parameters.Add(
                new Npgsql.NpgsqlParameter("limit", _options.SweepBatchSize)),
            ct);

        foreach (var (entryId, companyId) in work)
        {
            queue.EnqueueProcessing(entryId, companyId);
        }

        return work.Count;
    }

    private async Task<int> ParkAbandonedAsync(CancellationToken ct)
    {
        var cutoff = DateTime.UtcNow - _options.StaleProcessingAfter;

        var work = await ScanAsync(
            """
            SELECT id, company_id FROM entry
            WHERE status = 'processing'
              AND processing_started_at IS NOT NULL
              AND processing_started_at < @cutoff
            ORDER BY processing_started_at
            LIMIT @limit
            """,
            command =>
            {
                command.Parameters.Add(new Npgsql.NpgsqlParameter("cutoff", cutoff));
                command.Parameters.Add(
                    new Npgsql.NpgsqlParameter("limit", _options.SweepBatchSize));
            },
            ct);

        var parked = 0;

        foreach (var (entryId, companyId) in work)
        {
            // Back inside the tenant filter for the write: the scan found the work, the update
            // runs scoped like anything else.
            tenant.CompanyId = companyId;

            var updated = await db.Entries
                .Where(e => e.Id == entryId
                            && e.Status == EntryStatus.Processing
                            && e.ProcessingStartedAt != null
                            && e.ProcessingStartedAt < cutoff)
                .ExecuteUpdateAsync(
                    s => s
                        .SetProperty(e => e.Status, EntryStatus.NeedsReview)
                        .SetProperty(e => e.ProcessingStartedAt, (DateTime?)null)
                        .SetProperty(
                            e => e.FailureReason,
                            ProcessingFailure.Describe(
                                ProcessingFailure.ProcessingInterrupted,
                                "processing was claimed but never finished; the server most "
                                + "likely restarted mid-pass")),
                    ct);

            if (updated == 1)
            {
                parked++;
                logger.LogWarning(
                    "Entry {EntryId} was abandoned in processing and is now in needs_review.",
                    entryId);
            }
        }

        tenant.CompanyId = null;
        return parked;
    }

    /// <summary>
    /// The same safety net for B6 that <see cref="EnqueuePendingAsync"/> is for B4:
    /// <c>/confirm</c> enqueues the report, and an enqueue can be lost between the commit and
    /// the queue write.
    /// <para>
    /// The predicate is narrow on purpose, and the narrowness is the policy. It picks up only
    /// entries that carry <b>no failure reason at all</b> — meaning nothing has gone wrong that
    /// a person has been told about, so the only explanation for a confirmed unreported entry
    /// with no report is that the enqueue never landed. A report that failed with a reason is
    /// deliberately <em>not</em> retried here: an empty distribution list, a relay that refused
    /// the address, a photograph whose checksum does not match — none of those get better by
    /// being tried every minute, and an entry that keeps retrying and keeps dying is
    /// indistinguishable from an entry that was lost. That is the same call B4 made for
    /// <c>needs_review</c>. The retry path is a person fixing the cause and confirming again,
    /// which clears <c>failure_reason</c> and makes the entry eligible here once more.
    /// </para>
    /// <para>
    /// <b><c>sent</c> is in the predicate for a different reason, and it is not a resend.</b> A
    /// pass that died in the gap between recording <c>sent</c> and stamping <c>reported_at</c>
    /// leaves a report the client has and an entry the contractor's own archive says was never
    /// reported — permanently, and silently, because nothing else in the system looks at that
    /// state: <c>FailAbandonedReportsAsync</c> only knows about <c>sending</c>.
    /// <c>EntryReporter</c> has always had the recovery for it (a <c>sent</c> report is sealed,
    /// never re-sent), and this line is what actually drives it.
    /// </para>
    /// </summary>
    private async Task<int> EnqueuePendingReportsAsync(CancellationToken ct)
    {
        var work = await ScanAsync(
            """
            SELECT e.id, e.company_id
            FROM entry e
            LEFT JOIN report r ON r.entry_id = e.id
            WHERE e.status = 'confirmed'
              AND e.reported_at IS NULL
              AND e.failure_reason IS NULL
              AND (r.id IS NULL OR r.status IN ('failed', 'sent'))
            ORDER BY e.confirmed_at
            LIMIT @limit
            """,
            command => command.Parameters.Add(
                new Npgsql.NpgsqlParameter("limit", _options.SweepBatchSize)),
            ct);

        foreach (var (entryId, companyId) in work)
        {
            queue.EnqueueReport(entryId, companyId);
        }

        return work.Count;
    }

    /// <summary>
    /// A report claimed for sending whose worker never came back — a deploy, a crash, an OOM.
    /// <para>
    /// It is marked <c>failed</c> and left there. **It is never re-sent automatically**, and
    /// that is the deliberate choice: the pass died somewhere around an SMTP conversation, and
    /// SMTP hands back no message id and no delivery telemetry (ARCHITECTURE §10), so the server
    /// genuinely cannot say whether the relay took the message. Guessing "no" would put a second
    /// copy of a site diary in an investor's inbox; guessing "yes" would seal an entry that was
    /// never sent. So it says what it knows — <c>report_interrupted</c> — on both the report row
    /// and the entry, and a person decides.
    /// </para>
    /// </summary>
    private async Task<int> FailAbandonedReportsAsync(CancellationToken ct)
    {
        var cutoff = DateTime.UtcNow - _reporting.StaleAfter;

        var work = await ScanAsync(
            """
            SELECT id, company_id FROM report
            WHERE status = 'sending'
              AND attempt_started_at IS NOT NULL
              AND attempt_started_at < @cutoff
            ORDER BY attempt_started_at
            LIMIT @limit
            """,
            command =>
            {
                command.Parameters.Add(new Npgsql.NpgsqlParameter("cutoff", cutoff));
                command.Parameters.Add(
                    new Npgsql.NpgsqlParameter("limit", _options.SweepBatchSize));
            },
            ct);

        var failed = 0;
        var reason = ReportFailure.Describe(
            ReportFailure.ReportInterrupted,
            "the report was claimed for sending but the pass never finished; the server cannot "
            + "tell whether the mail relay took the message, so it will not send it again by "
            + "itself");

        foreach (var (reportId, companyId) in work)
        {
            // Back inside the tenant filter for the write: the scan found the work, the updates
            // run scoped like anything else.
            tenant.CompanyId = companyId;

            var updated = await db.Reports
                .Where(r => r.Id == reportId
                            && r.Status == ReportStatus.Sending
                            && r.AttemptStartedAt != null
                            && r.AttemptStartedAt < cutoff)
                .ExecuteUpdateAsync(
                    s => s
                        .SetProperty(r => r.Status, ReportStatus.Failed)
                        .SetProperty(r => r.AttemptStartedAt, (DateTime?)null)
                        .SetProperty(r => r.FailureReason, reason),
                    ct);

            if (updated != 1)
            {
                continue;
            }

            failed++;

            // The same reason on the entry, so it is visible where the foreman looks — and it
            // is what keeps the enqueue sweep above from picking the entry straight back up.
            await db.Entries
                .Where(e => e.Status == EntryStatus.Confirmed
                            && e.ReportedAt == null
                            && db.Reports.Any(r => r.Id == reportId && r.EntryId == e.Id))
                .ExecuteUpdateAsync(s => s.SetProperty(e => e.FailureReason, reason), ct);

            logger.LogWarning(
                "Report {ReportId} was abandoned mid-send and is now failed; whether the relay "
                + "took the message is unknown.", reportId);
        }

        tenant.CompanyId = null;
        return failed;
    }

    private async Task<List<(Guid EntryId, Guid CompanyId)>> ScanAsync(
        string sql, Action<Npgsql.NpgsqlCommand> configure, CancellationToken ct)
    {
        var connection = (Npgsql.NpgsqlConnection)db.Database.GetDbConnection();
        var wasClosed = connection.State != System.Data.ConnectionState.Open;

        if (wasClosed)
        {
            await connection.OpenAsync(ct);
        }

        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            configure(command);

            var results = new List<(Guid, Guid)>();
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                results.Add((reader.GetGuid(0), reader.GetGuid(1)));
            }

            return results;
        }
        finally
        {
            if (wasClosed)
            {
                await connection.CloseAsync();
            }
        }
    }
}

/// <summary>What one sweep found. Four numbers because the sweep now covers two pipelines:
/// the B4 processing pass and the B6 report pass, each with a "never queued" case and an
/// "abandoned mid-pass" case.</summary>
public sealed record SweepResult(
    int Enqueued, int Parked, int ReportsQueued, int ReportsFailed);
