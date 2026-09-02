using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Serilog.Debugging;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// The timer that moves rows from the queue into the table.
///
/// <para>
/// It exists so that <see cref="PostgresLogSink"/> can be a pure enqueue. Everything about writing
/// log lines that could be slow, could fail, or could need a database connection happens on this
/// one background loop, off every request thread and off every Hangfire worker.
/// </para>
///
/// <para>
/// <b>It flushes once more on shutdown</b>, with a short budget of its own. A deploy restarts this
/// process, and the last few seconds of log lines are exactly the ones somebody will want if the
/// restart was not planned. The budget is there because a host that will not stop is worse than a
/// handful of lost lines.
/// </para>
/// </summary>
public sealed class AppLogFlushService(
    AppLogWriter writer, AppLogQueue queue, IOptions<LoggingOptions> options) : BackgroundService
{
    /// <summary>How long the final flush may take while the host is stopping.</summary>
    public static readonly TimeSpan ShutdownBudget = TimeSpan.FromSeconds(5);

    private readonly LoggingOptions _options = options.Value;
    private long _reportedDrops;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            return;
        }

        using var timer = new PeriodicTimer(_options.FlushInterval);

        while (await SafeWaitAsync(timer, stoppingToken))
        {
            await FlushQuietlyAsync(stoppingToken);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);

        if (!_options.Enabled)
        {
            return;
        }

        using var budget = new CancellationTokenSource(ShutdownBudget);
        await FlushQuietlyAsync(budget.Token);
    }

    private static async Task<bool> SafeWaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try
        {
            return await timer.WaitForNextTickAsync(ct);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>
    /// <b>Nothing in here may throw and nothing in here may log through <c>ILogger</c>.</b> An
    /// unhandled exception on a <see cref="BackgroundService"/> stops the host by default, which
    /// would mean an unreachable log table taking down an API that is otherwise serving foremen;
    /// and an <c>ILogger</c> call would enqueue a row about the failure to write rows.
    /// </summary>
    private async Task FlushQuietlyAsync(CancellationToken ct)
    {
        try
        {
            await writer.FlushAsync(ct);
            ReportDrops();
        }
        catch (OperationCanceledException)
        {
            // Shutting down, or out of budget. Either way there is nothing useful to say.
        }
        catch (Exception ex)
        {
            SelfLog.WriteLine("app_log: the flush loop failed: {0}", ex);
        }
    }

    /// <summary>
    /// A gap in the log stream must never be silent. When the queue has thrown rows away, the fact
    /// is written to <see cref="SelfLog"/> — not to <c>app_log</c>, because the writer that would
    /// carry it is precisely the one that could not keep up.
    /// </summary>
    private void ReportDrops()
    {
        var dropped = queue.Dropped;
        if (dropped <= _reportedDrops)
        {
            return;
        }

        SelfLog.WriteLine(
            "app_log: {0} row(s) dropped since start-up because the queue was full.", dropped);

        _reportedDrops = dropped;
    }
}
