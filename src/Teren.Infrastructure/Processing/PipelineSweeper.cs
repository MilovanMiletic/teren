using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Teren.Core.Entities;
using Teren.Core.Processing;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Persistence;

namespace Teren.Infrastructure.Processing;

/// <summary>
/// The safety net under the enqueue path, and the reason a lost job is not a lost entry.
/// <para>
/// Two jobs, one pass:
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
    ILogger<PipelineSweeper> logger)
{
    private readonly PipelineOptions _options = options.Value;

    public async Task<SweepResult> SweepAsync(CancellationToken ct)
    {
        var enqueued = await EnqueuePendingAsync(ct);
        var parked = await ParkAbandonedAsync(ct);

        if (enqueued > 0 || parked > 0)
        {
            logger.LogInformation(
                "Pipeline sweep: {Enqueued} entry(ies) queued, {Parked} abandoned entry(ies) "
                + "parked for review.", enqueued, parked);
        }

        return new SweepResult(enqueued, parked);
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

public sealed record SweepResult(int Enqueued, int Parked);
