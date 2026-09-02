using Serilog.Debugging;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// Serilog's own failure channel, turned on — and the answer to "what happens when the thing that
/// records failures is the thing that is failing".
///
/// <para>
/// <b>Every way the <c>app_log</c> sink can fail reports here and nowhere else.</b> A log event
/// that could not be built (<see cref="PostgresLogSink"/>), a batch the database refused
/// (<see cref="AppLogWriter"/>), a flush loop that threw, a queue that overflowed
/// (<see cref="AppLogFlushService"/>): all four go to <see cref="SelfLog"/>, because an
/// <c>ILogger</c> call from inside the log writer would enqueue a row about failing to write rows
/// and recurse until the process died of it.
/// </para>
///
/// <para>
/// <b><see cref="SelfLog"/> is disabled by default, which made all four of those silent.</b> That
/// is not a theoretical gap in this repo: a host started without <c>migrate</c> is its single most
/// repeated failure, and an <c>app_log</c> table that does not exist yet means every batch is
/// dropped on a <c>42P01</c> while the log viewer simply looks empty — with nothing, anywhere,
/// saying why. Turning it on costs a line on stderr and is what makes "a gap in the log stream is
/// never silent" true rather than intended.
/// </para>
///
/// <para>
/// <b>stderr and not the log</b>: this channel exists precisely for the moments the log is not
/// working, so it must not route through anything the sink touches. It is where the operator
/// standing at the process — or reading <c>docker compose logs</c> — is already looking.
/// </para>
/// </summary>
public static class SelfLogChannel
{
    private static int _enabled;

    /// <summary>
    /// Whether this process turned the channel on. Tracked here because <see cref="SelfLog"/>
    /// itself exposes no way to ask, and "the sink's failures are audible" is a property worth a
    /// test rather than a hope.
    /// </summary>
    public static bool IsEnabled => Volatile.Read(ref _enabled) == 1;

    /// <summary>Send Serilog's internal diagnostics to standard error. Idempotent.</summary>
    public static void EnableToStandardError()
    {
        SelfLog.Enable(Console.Error);
        Volatile.Write(ref _enabled, 1);
    }
}
