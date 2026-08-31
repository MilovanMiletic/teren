using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Records the exact sequence of SQL statements a request issues, so a test can assert on the
/// <em>shape</em> of the database work rather than on how long it took.
/// <para>
/// <b>This exists because a stopwatch cannot be trusted to catch a small constant.</b>
/// <see cref="ActivationTimingTests"/> compares branch medians, which catches a branch that skips
/// most of its round trips and misses a branch that pays one extra insert — the second is still a
/// perfectly usable oracle for an attacker with a few hundred samples, and no bound loose enough
/// to survive a busy machine is tight enough to see it. Recording the statements makes the same
/// property deterministic: four branches that issue the identical statement sequence cannot be
/// told apart by the work they do, and no amount of CI jitter changes the answer.
/// </para>
/// <para>
/// One recording at a time, which is all the suite needs — it runs in a single collection, and a
/// recording brackets exactly one awaited request.
/// </para>
/// </summary>
public sealed class CommandTapInterceptor : DbCommandInterceptor
{
    private readonly object _gate = new();

    private List<string>? _recording;

    /// <summary>Runs <paramref name="action"/> and returns every statement it issued, in order.
    /// The recording stops even if the action throws.</summary>
    public async Task<IReadOnlyList<string>> RecordAsync(Func<Task> action)
    {
        Start();

        try
        {
            await action();
        }
        catch
        {
            Stop();
            throw;
        }

        return Stop();
    }

    /// <summary>Drops any recording left behind by a failed test.</summary>
    public void Reset() => Stop();

    private void Start()
    {
        lock (_gate)
        {
            _recording = [];
        }
    }

    private IReadOnlyList<string> Stop()
    {
        lock (_gate)
        {
            var recorded = _recording ?? [];
            _recording = null;

            return recorded;
        }
    }

    private void Record(DbCommand command)
    {
        lock (_gate)
        {
            _recording?.Add(command.CommandText);
        }
    }

    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        Record(command);
        return result;
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        Record(command);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<int> NonQueryExecuting(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        Record(command);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Record(command);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<object> ScalarExecuting(
        DbCommand command, CommandEventData eventData, InterceptionResult<object> result)
    {
        Record(command);
        return result;
    }

    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<object> result,
        CancellationToken cancellationToken = default)
    {
        Record(command);
        return ValueTask.FromResult(result);
    }
}
