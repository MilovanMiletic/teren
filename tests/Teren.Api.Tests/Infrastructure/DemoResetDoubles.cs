using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// An in-memory bucket for the reset's object purge. It records the prefix it was asked for,
/// which is the part that matters: a reset that swept the wrong prefix would delete another
/// company's evidence, and no row count would show it.
/// </summary>
public sealed class FakeDemoObjectPurge : IDemoObjectPurge
{
    private readonly Dictionary<string, byte> _keys = new(StringComparer.Ordinal);

    public List<string> PrefixesListed { get; } = [];

    public List<string> KeysDeleted { get; } = [];

    /// <summary>When set, both calls throw it — an unreachable bucket.</summary>
    public Exception? Fault { get; set; }

    public IReadOnlyCollection<string> Remaining => _keys.Keys;

    public void Put(params string[] keys)
    {
        foreach (var key in keys)
        {
            _keys[key] = 0;
        }
    }

    public Task<IReadOnlyList<string>> ListAsync(string prefix, CancellationToken ct = default)
    {
        if (Fault is not null)
        {
            throw Fault;
        }

        PrefixesListed.Add(prefix);

        return Task.FromResult<IReadOnlyList<string>>(
            [.. _keys.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal))]);
    }

    public Task<int> DeleteAsync(IReadOnlyList<string> keys, CancellationToken ct = default)
    {
        if (Fault is not null)
        {
            throw Fault;
        }

        var deleted = 0;

        foreach (var key in keys)
        {
            KeysDeleted.Add(key);

            if (_keys.Remove(key))
            {
                deleted++;
            }
        }

        return Task.FromResult(deleted);
    }
}

/// <summary>A queue of pending job ids, in memory.</summary>
public sealed class FakeDemoJobPurge : IDemoJobPurge
{
    private readonly List<string> _pending = [];

    public string? Unavailable { get; set; }

    public List<string> Deleted { get; } = [];

    public IReadOnlyList<string> Pending => _pending;

    public void Enqueue(params string[] jobIds) => _pending.AddRange(jobIds);

    public Task<IReadOnlyList<string>> ListPendingAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<string>>([.. _pending]);

    public Task<int> DeleteAsync(IReadOnlyList<string> jobIds, CancellationToken ct = default)
    {
        Deleted.AddRange(jobIds);
        var removed = jobIds.Count(id => _pending.Remove(id));
        return Task.FromResult(removed);
    }
}

/// <summary>
/// Throws the first time a command whose SQL contains a given fragment is about to run, then
/// stands down. The only way to arrange "the reset died between the deletes and the re-seed"
/// without putting a test hook in production code — and that is the case the whole
/// disable-inside-the-transaction design exists for.
/// </summary>
public sealed class FailOnceInterceptor(string sqlFragment) : DbCommandInterceptor
{
    private int _fired;
    private volatile bool _armed;

    public bool Fired => _fired > 0;

    /// <summary>Starts disarmed, so the arrange can seed the database it is about to reset.</summary>
    public void Arm() => _armed = true;

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        Trip(command);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Trip(command);
        return base.NonQueryExecutingAsync(command, eventData, result, cancellationToken);
    }

    private void Trip(DbCommand command)
    {
        if (!_armed
            || !command.CommandText.Contains(sqlFragment, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (Interlocked.Exchange(ref _fired, 1) != 0)
        {
            return;
        }

        throw new InvalidOperationException(
            $"injected failure on a command containing \"{sqlFragment}\"");
    }
}
