using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;
using Serilog.Debugging;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// The only thing in the process that writes <c>app_log</c>, and the only thing that is allowed to
/// be slow about it.
///
/// <para>
/// <b>Raw Npgsql, not EF.</b> Two reasons, and both are about not eating our own tail: a DbContext
/// logs its own commands, so writing log rows through EF is a loop waiting for a bad
/// <c>MinimumLevel</c> to find it; and change tracking on a firehose buys nothing but allocations.
/// One <see cref="NpgsqlBatch"/> per flush is one round trip for up to
/// <see cref="LoggingOptions.BatchSize"/> lines.
/// </para>
///
/// <para>
/// <b>It never throws and it never logs.</b> A failure here is reported to Serilog's
/// <see cref="SelfLog"/> — the one channel that cannot recurse — because an <c>ILogger</c> call
/// from inside the log writer would enqueue a row, fail to write it, log about that, and so on
/// until the process died of it. Losing log lines while the database is unreachable is the correct
/// outcome; taking the API down with them is not.
/// </para>
/// </summary>
public sealed class AppLogWriter(
    AppLogQueue queue, NpgsqlDataSource dataSource, IOptions<LoggingOptions> options)
{
    private const string Insert =
        """
        INSERT INTO app_log
            (at, level, source, template, message, properties, exception,
             company_id, entry_id, correlation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        """;

    private readonly LoggingOptions _options = options.Value;

    /// <summary>
    /// Drains the queue into the database and returns how many rows were written.
    ///
    /// <para>
    /// Loops until the queue is empty rather than writing one batch per tick: after a stall, one
    /// batch every two seconds would take minutes to catch up while the queue kept dropping the
    /// oldest lines — which are the ones explaining the stall.
    /// </para>
    /// <para>
    /// <b>A failed batch is dropped, not retried.</b> Re-queuing it would mean the same failing
    /// rows are attempted forever while live ones are pushed out behind them, and the flush would
    /// never make progress again once the table was, say, missing.
    /// </para>
    /// </summary>
    public async Task<int> FlushAsync(CancellationToken ct = default)
    {
        var written = 0;

        while (!ct.IsCancellationRequested)
        {
            var batch = queue.Take(_options.BatchSize);
            if (batch.Count == 0)
            {
                break;
            }

            try
            {
                await WriteAsync(batch, ct);
                written += batch.Count;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                SelfLog.WriteLine(
                    "app_log: dropped {0} row(s), the batch could not be written: {1}",
                    batch.Count,
                    ex.Message);
                break;
            }

            if (batch.Count < _options.BatchSize)
            {
                break;
            }
        }

        return written;
    }

    private async Task WriteAsync(List<AppLogRow> rows, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var batch = new NpgsqlBatch(connection);

        foreach (var row in rows)
        {
            var command = new NpgsqlBatchCommand(Insert);

            command.Parameters.Add(new NpgsqlParameter
            {
                Value = row.At,
                NpgsqlDbType = NpgsqlDbType.TimestampTz,
            });
            Add(command, row.Level);
            Add(command, row.Source);
            Add(command, row.Template);
            Add(command, row.Message);
            command.Parameters.Add(new NpgsqlParameter
            {
                Value = (object?)row.Properties ?? DBNull.Value,
                NpgsqlDbType = NpgsqlDbType.Jsonb,
            });
            Add(command, row.Exception);
            AddUuid(command, row.CompanyId);
            AddUuid(command, row.EntryId);
            Add(command, row.Correlation);

            batch.BatchCommands.Add(command);
        }

        await batch.ExecuteNonQueryAsync(ct);
    }

    private static void Add(NpgsqlBatchCommand command, string? value) =>
        command.Parameters.Add(new NpgsqlParameter
        {
            Value = (object?)value ?? DBNull.Value,
            NpgsqlDbType = NpgsqlDbType.Text,
        });

    private static void AddUuid(NpgsqlBatchCommand command, Guid? value) =>
        command.Parameters.Add(new NpgsqlParameter
        {
            Value = (object?)value ?? DBNull.Value,
            NpgsqlDbType = NpgsqlDbType.Uuid,
        });
}
