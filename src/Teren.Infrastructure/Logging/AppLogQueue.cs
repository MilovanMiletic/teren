using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// One row on its way to <c>app_log</c>, already scrubbed. Built on the calling thread, written by
/// somebody else.
/// </summary>
/// <remarks>
/// It is a separate type from <see cref="Teren.Core.Entities.AppLog"/> on purpose: the entity is
/// what the log <em>viewer</em> reads through EF, and this is what the writer inserts with raw
/// Npgsql. Sharing one type would drag a change-tracking DbContext onto the write path of every
/// log line in the product.
/// </remarks>
public sealed record AppLogRow(
    DateTime At,
    string Level,
    string Source,
    string Template,
    string Message,
    string? Properties,
    string? Exception,
    Guid? CompanyId,
    Guid? EntryId,
    string? Correlation);

/// <summary>
/// The bounded buffer between a log call and the database.
///
/// <para>
/// <b>This type is the reason a log call cannot block on Postgres and cannot throw into a
/// request.</b> Emitting a line is an enqueue and nothing else — no connection, no await, no
/// transaction — and the background flusher is the only thing that ever talks to the database.
/// A phone-facing handler that logs a warning while the database is unreachable pays nothing at
/// all.
/// </para>
///
/// <para>
/// <b>Bounded, and drop-oldest when full.</b> Unbounded would turn a stuck writer into a slow
/// out-of-memory kill of a process that was otherwise serving foremen perfectly well. Dropping the
/// <em>oldest</em> rather than the newest is the deliberate half: when the writer is stuck, the
/// lines being written right now are the ones about whatever is going wrong, and the stale ones at
/// the front are the least useful bytes in the process. Every drop increments
/// <see cref="Dropped"/>, which the flusher reports, so a silent gap in the log stream is never
/// silent.
/// </para>
/// </summary>
public sealed class AppLogQueue(IOptions<LoggingOptions> options)
{
    private readonly ConcurrentQueue<AppLogRow> _rows = new();
    private readonly int _capacity = options.Value.QueueCapacity;
    private int _count;
    private long _dropped;

    /// <summary>How many rows were thrown away because the writer could not keep up. Cumulative,
    /// and reported by the flusher the next time it succeeds.</summary>
    public long Dropped => Interlocked.Read(ref _dropped);

    public int Count => Volatile.Read(ref _count);

    /// <summary>
    /// Hand a row over. Never throws and never waits: a log call is not allowed to be a reason a
    /// request fails.
    /// </summary>
    public void Enqueue(AppLogRow row)
    {
        _rows.Enqueue(row);

        // Trimmed after the fact rather than before, and at most one row per enqueue, so two
        // threads racing at the boundary cost a handful of extra rows rather than a lock on what
        // is now the hottest path in the process. The overshoot is bounded by the number of
        // threads logging at once; the capacity is not a promise to the byte.
        if (Interlocked.Increment(ref _count) > _capacity && _rows.TryDequeue(out _))
        {
            Interlocked.Decrement(ref _count);
            Interlocked.Increment(ref _dropped);
        }
    }

    /// <summary>Take up to <paramref name="max"/> rows, oldest first. Returns an empty list when
    /// there is nothing to write, which is the ordinary case.</summary>
    public List<AppLogRow> Take(int max)
    {
        var batch = new List<AppLogRow>(Math.Min(max, 64));

        while (batch.Count < max && _rows.TryDequeue(out var row))
        {
            Interlocked.Decrement(ref _count);
            batch.Add(row);
        }

        return batch;
    }

    /// <summary>
    /// Throw the buffer away without writing it.
    /// <para>
    /// For the test suite only, and it exists because the alternative is worse: every test in the
    /// run emits log lines, and a test that flushes would otherwise see the previous test's
    /// warnings in the table it is asserting about. Truncating <c>app_log</c> without draining the
    /// queue first would leave those lines to arrive <em>after</em> the truncate.
    /// </para>
    /// </summary>
    public void Discard()
    {
        while (_rows.TryDequeue(out _))
        {
            Interlocked.Decrement(ref _count);
        }

        Interlocked.Exchange(ref _dropped, 0);
    }
}
