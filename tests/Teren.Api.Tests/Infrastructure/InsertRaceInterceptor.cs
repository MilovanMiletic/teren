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
    private Func<DbCommand, Task>? _hook;
    private string _insertFragment = string.Empty;

    /// <summary>Runs the hook before the next INSERT into <c>entry</c>, then disarms.</summary>
    public void ArmOnceBeforeEntryInsert(Func<Task> hook) => ArmOnce("INSERT INTO entry", hook);

    /// <summary>Runs the hook before the next INSERT into <c>media</c>, then disarms.</summary>
    public void ArmOnceBeforeMediaInsert(Func<Task> hook) => ArmOnce("INSERT INTO media", hook);

    /// <summary>
    /// Runs the hook before the next INSERT into <c>app_user</c>, then disarms — the other admin
    /// who added a man with the same name a moment earlier, so <c>ux_app_user_username</c> refuses
    /// this one and <c>CreateWorkerAsync</c>'s retry has to run.
    /// </summary>
    public void ArmOnceBeforeUserInsert(Func<Task> hook) => ArmOnce("INSERT INTO app_user", hook);

    /// <summary>
    /// Runs the hook before the next INSERT into <c>activation_code</c>, then disarms — the
    /// competing issue that makes <c>ux_activation_code_live</c> refuse this one, so
    /// <c>ActivationCodes.IssueAsync</c>'s retry loop has to run.
    /// </summary>
    public void ArmOnceBeforeActivationCodeInsert(Func<Task> hook) =>
        ArmOnce("INSERT INTO activation_code", hook);

    /// <summary>
    /// The same arming point, but the hook is handed the command that is about to run so it can
    /// write on <b>the handler's own connection and transaction</b>.
    /// <para>
    /// This is the only way to arrange the savepoint half of
    /// <c>ActivationCodes.IssueAsync</c>. That path runs inside <c>CreateWorkerAsync</c>'s
    /// transaction, where the worker the code belongs to has been inserted but not committed — so
    /// a competing row written on a second connection would be refused by
    /// <c>fk_activation_code_user</c> long before it could collide with anything. Writing inside
    /// the transaction reaches the row.
    /// </para>
    /// </summary>
    public void ArmOnceInsideTransactionBeforeActivationCodeInsert(Func<DbCommand, Task> hook) =>
        ArmOnce("INSERT INTO activation_code", hook);

    /// <summary>
    /// Runs the hook immediately before the conditional UPDATE that claims an activation code,
    /// then disarms.
    /// <para>
    /// This is the one that proves a single-use code is single-use <em>under contention</em>: the
    /// hook runs a whole second activation, which commits, and the outer statement then finds
    /// <c>consumed_at</c> already set and matches zero rows. Two phones, one code, exactly one
    /// device — deterministically, rather than by firing two requests and hoping one loses.
    /// </para>
    /// </summary>
    public void ArmOnceBeforeActivationCodeClaim(Func<Task> hook) =>
        ArmOnce("UPDATE activation_code", hook);

    public void Disarm()
    {
        _hook = null;
        _insertFragment = string.Empty;
    }

    private void ArmOnce(string insertFragment, Func<Task> hook) =>
        ArmOnce(insertFragment, _ => hook());

    private void ArmOnce(string insertFragment, Func<DbCommand, Task> hook)
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
        await hook(command);
    }
}
