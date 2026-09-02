using Hangfire;
using Hangfire.Server;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;
using Teren.Infrastructure.Persistence;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// Deletes log rows older than <c>Logging:RetentionDays</c>, once a day.
///
/// <para>
/// <b>Without this the log table becomes the largest thing in the database</b> and the nightly
/// backup grows without bound until restoring it is the slowest step in a recovery — on a product
/// whose whole value is that a customer's evidence can be produced later. Retention is a decision
/// the plan makes explicitly (§12), not a default anyone should have to discover.
/// </para>
///
/// <para>
/// <b>Deleted in chunks, not in one statement.</b> A fortnight of a busy month is a lot of rows,
/// and a single <c>DELETE</c> holds one long transaction that blocks the writer behind it — so the
/// job that keeps the log healthy would be the reason log lines stop arriving. Each chunk is its
/// own statement; being interrupted half way through simply leaves fewer rows to delete tomorrow.
/// </para>
///
/// <para>
/// <c>[AutomaticRetry(Attempts = 0)]</c> like every other job in this product: it is idempotent and
/// it runs again tomorrow, so a scheduler retry would buy nothing and would stack a second budget
/// on a job that already bounds itself.
/// </para>
/// </summary>
[AutomaticRetry(Attempts = 0)]
public sealed class LogRetentionJob(
    TerenIdentityDbContext db,
    IOptions<LoggingOptions> options,
    ILogger<LogRetentionJob> logger)
{
    public const string RecurringJobId = "app-log-retention";

    /// <summary>03:20 UTC — after the small hours' quiet has started and well clear of any hour a
    /// foreman is on site.</summary>
    public const string Schedule = "20 3 * * *";

    private const int ChunkSize = 10_000;

    /// <summary>
    /// <c>ctid</c> rather than <c>id</c> because a chunked delete wants the physical row and not a
    /// second index lookup; <c>ix_app_log_at</c> is what finds the candidates.
    /// </summary>
    private const string DeleteChunk =
        """
        DELETE FROM app_log
        WHERE ctid IN (SELECT ctid FROM app_log WHERE at < @cutoff LIMIT @chunk)
        """;

    public async Task<int> RunAsync(IJobCancellationToken? cancellation)
    {
        var ct = cancellation?.ShutdownToken ?? CancellationToken.None;

        var days = options.Value.RetentionDays;
        var cutoff = DateTime.UtcNow.AddDays(-days);
        var deleted = 0;

        while (!ct.IsCancellationRequested)
        {
            var removed = await db.Database.ExecuteSqlRawAsync(
                DeleteChunk,
                [
                    new NpgsqlParameter("cutoff", cutoff),
                    new NpgsqlParameter("chunk", ChunkSize),
                ],
                ct);

            deleted += removed;

            if (removed < ChunkSize)
            {
                break;
            }
        }

        // Counts only, and one line a day: this job's own output must not be a meaningful part of
        // what it is cleaning up.
        logger.LogInformation(
            "Log retention: {Deleted} row(s) older than {Total} day(s) removed.", deleted, days);

        return deleted;
    }
}
