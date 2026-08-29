using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Makes the "two copies of the same POST in flight" race deterministic instead of hoping for it.
/// <para>
/// Armed with <see cref="ArmOnceBeforeEntryInsert"/> or
/// <see cref="ArmOnceBeforeMediaInsert"/>, it runs the supplied hook immediately before EF issues
/// the INSERT into that table — the hook inserts the competing row on its own connection, so EF's
/// insert hits <c>pk_entry</c> or <c>pk_media</c> and the handler's unique-violation branch runs
/// every single time. A test that fired N parallel requests and hoped one of them lost would be a
/// coin toss dressed up as a test.
/// </para>
/// <para>
/// Both tables are supported because both upload-path handlers translate a primary-key violation
/// into an answer, and both have to tell the caller's own retry (409, re-request the URLs) apart
/// from another tenant's id (404). A branch that cannot be arranged cannot be tested, and an
/// untested branch is exactly where a spurious terminal 404 would strand a phone's evidence.
/// </para>
/// </summary>
public sealed class InsertRaceInterceptor : DbCommandInterceptor
{
    private Func<Task>? _hook;
    private string _insertFragment = string.Empty;

    /// <summary>Runs the hook before the next INSERT into <c>entry</c>, then disarms.</summary>
    public void ArmOnceBeforeEntryInsert(Func<Task> hook) => ArmOnce("INSERT INTO entry", hook);

    /// <summary>Runs the hook before the next INSERT into <c>media</c>, then disarms.</summary>
    public void ArmOnceBeforeMediaInsert(Func<Task> hook) => ArmOnce("INSERT INTO media", hook);

    public void Disarm()
    {
        _hook = null;
        _insertFragment = string.Empty;
    }

    private void ArmOnce(string insertFragment, Func<Task> hook)
    {
        _insertFragment = insertFragment;
        _hook = hook;
    }

    public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        await RunHookIfArmedInsertAsync(command);
        return result;
    }

    public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        await RunHookIfArmedInsertAsync(command);
        return result;
    }

    private async Task RunHookIfArmedInsertAsync(DbCommand command)
    {
        var hook = _hook;
        if (hook is null
            || !command.CommandText.Contains(_insertFragment, StringComparison.Ordinal))
        {
            return;
        }

        Disarm();
        await hook();
    }
}
