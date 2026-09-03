using Hangfire.Server;

namespace Teren.Api.Health;

/// <summary>
/// The id Hangfire gave <b>this process's</b> job server, recorded the moment the server starts
/// running its processes.
///
/// <para>
/// <b>Why this exists at all.</b> <see cref="JobServerReadyCheck"/> used to count any row in
/// Hangfire's server table whose heartbeat was recent. That is not the question readiness asks. A
/// server row survives its process by up to Hangfire's five-minute server timeout, so a container
/// that crashed and came back with a job server that failed to start would read its own corpse's
/// heartbeat as fresh and report itself ready — for as long as the dead row lived. And in a
/// container the coincidence is not far-fetched: the API is pid 1 in its own namespace and the
/// machine name is the container id, so a restarted process can compose exactly the same
/// <c>machine:pid</c> prefix the dead one had. Only the id Hangfire actually handed <em>this</em>
/// server distinguishes them.
/// </para>
///
/// <para>
/// <b>Read from Hangfire rather than reconstructed.</b> The shape of a server id is Hangfire's
/// business — it is <c>{machine}:{pid}:{guid}</c> today, confirmed by reading
/// <c>hangfire.server</c> on the dev database, but that is an observation about 1.8.25 and not a
/// contract. <see cref="BackgroundProcessContext.ServerId"/> is the published way to be told it,
/// so a <see cref="IBackgroundProcess"/> that does nothing but write it down is the whole
/// mechanism. Nothing here parses or composes an id.
/// </para>
///
/// <para>
/// <b>Unknown until the server runs, and that is a true answer rather than a gap.</b> A process
/// whose job server never started has no id here, and readiness fails — which is precisely the
/// state this check exists to catch.
/// </para>
/// </summary>
public sealed class JobServerIdentity
{
    private string? serverId;

    /// <summary>The id, or null while no job server in this process has announced itself.</summary>
    public string? ServerId => Volatile.Read(ref serverId);

    public void Announce(string id) => Volatile.Write(ref serverId, id);
}

/// <summary>
/// A Hangfire background process whose entire job is to tell <see cref="JobServerIdentity"/> which
/// server id this process is running under.
///
/// <para>
/// It is registered as an <see cref="IBackgroundProcess"/> in the container;
/// <c>AddHangfireServer</c> resolves those from the service provider and runs them alongside the
/// workers. After recording the id it parks on <see cref="BackgroundProcessContext.Wait"/> until
/// shutdown — a background process that returns immediately is re-invoked in a tight loop, which
/// would turn a one-line observation into a spin.
/// </para>
/// </summary>
public sealed class JobServerAnnouncement(JobServerIdentity identity, ILogger<JobServerAnnouncement> logger)
    : IBackgroundProcess
{
    /// <summary>Long enough to be a park rather than a poll; the wait ends early on shutdown.</summary>
    private static readonly TimeSpan Parked = TimeSpan.FromMinutes(5);

    public void Execute(BackgroundProcessContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        if (identity.ServerId != context.ServerId)
        {
            identity.Announce(context.ServerId);

            // Once per process, and it is the line that makes a readiness failure legible: the id
            // in this log is the one /health/ready is looking for in the server table.
            logger.LogInformation(
                "Hangfire job server {JobServerId} is running in this process.", context.ServerId);
        }

        context.Wait(Parked);
    }
}
