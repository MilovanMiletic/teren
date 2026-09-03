using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Health;

/// <summary>
/// What <c>/health/ready</c> actually asks, and why there are two health routes rather than one.
///
/// <para>
/// <c>/health</c> is <b>liveness</b> and is a constant: the process is up and Kestrel is
/// answering. That is all it ever claimed and all it should claim — a liveness probe that fails
/// because a database is briefly unreachable is a probe that restarts a healthy process.
/// </para>
///
/// <para>
/// <b>It was also the only thing the deploy verified, and that is the gap these checks close.</b>
/// This repository's most repeated failure is a host started without <c>migrate</c>: the API
/// boots, answers <c>ok</c>, and then dies per request on a bare Npgsql <c>42703 column does not
/// exist</c> or <c>42P01</c> (CLAUDE.md records it biting twice, once silently killing the money
/// path). A missing IANA time-zone database did the same thing from a different direction — every
/// report failed with <c>time_zone_unknown</c> while <c>/health</c> said <c>ok</c> throughout
/// (deploy/README.md §8). A constant cannot tell a deploy anything it did not already know.
/// </para>
///
/// <para>
/// <b>Two migration histories, and both are checked.</b> Since D1 the evidence model and the
/// identity model migrate separately — <c>__EFMigrationsHistory</c> and
/// <c>__EFMigrationsHistory_identity</c> — and the D1 review found <c>reset-demo</c> applying only
/// one and dying on the other's absence. A readiness check that looked at one context would have
/// been green on precisely that host.
/// </para>
///
/// <para>
/// <b>The body carries a fixed vocabulary and nothing else.</b> <c>/health/ready</c> is
/// unauthenticated (the container healthcheck and <c>deploy.sh</c> both call it before anything is
/// signed in), so the detail — which migration, which exception message — is logged and never
/// written to the response. See <see cref="ReadinessEndpoint"/>.
/// </para>
/// </summary>
public static class ReadinessChecks
{
    public const string Database = "database";
    public const string Migrations = "migrations";
    public const string JobServer = "jobs";
}

/// <summary>
/// <c>SELECT 1</c> on <b>both</b> contexts.
/// <para>
/// Deliberately a query and not <c>CanConnectAsync</c>: opening a pooled connection can succeed
/// against a server that will not answer, and the cheapest statement there is settles it. Both
/// contexts share one connection string today, so this is one round trip repeated — and it is
/// written per context on purpose, because "they share a connection string" is a fact about
/// today's configuration and not a property of the model split.
/// </para>
/// </summary>
public sealed class DatabaseReadyCheck(
    TerenDbContext db,
    TerenIdentityDbContext identityDb,
    ILogger<DatabaseReadyCheck> logger) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken ct = default)
    {
        foreach (var (name, database) in new[]
        {
            (nameof(TerenDbContext), db.Database),
            (nameof(TerenIdentityDbContext), identityDb.Database),
        })
        {
            try
            {
                await database.ExecuteSqlRawAsync("SELECT 1", ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The reason lives here and not in the response body: this route is public.
                logger.LogError(ex, "Readiness: {DbContextName} cannot reach its database.", name);

                return HealthCheckResult.Unhealthy($"{name}: no database");
            }
        }

        return HealthCheckResult.Healthy();
    }
}

/// <summary>
/// Every migration of every context is applied.
/// <para>
/// Asked through EF's own migrator rather than by reading the history tables directly, so the
/// question is "does the history contain the latest migration <em>this build carries</em>" — which
/// is the question a deploy has. A history table that does not exist at all answers it too: every
/// migration is then pending, which is exactly the un-migrated host this check exists for.
/// </para>
/// </summary>
public sealed class MigrationsReadyCheck(
    TerenDbContext db,
    TerenIdentityDbContext identityDb,
    ILogger<MigrationsReadyCheck> logger) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken ct = default)
    {
        foreach (var (name, database) in new[]
        {
            (nameof(TerenDbContext), db.Database),
            (nameof(TerenIdentityDbContext), identityDb.Database),
        })
        {
            IReadOnlyList<string> pending;
            try
            {
                pending = [.. await database.GetPendingMigrationsAsync(ct)];
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(
                    ex, "Readiness: {DbContextName}'s migration history could not be read.", name);

                return HealthCheckResult.Unhealthy($"{name}: history unreadable");
            }

            if (pending.Count > 0)
            {
                // Named in the log because this is the one failure with an obvious fix, and the
                // fix is a command: `dotnet Teren.Api.dll migrate`.
                logger.LogError(
                    "Readiness: {DbContextName} is {PendingCount} migration(s) behind "
                    + "({PendingMigrations}). Run "
                    + "`migrate` — an API serving requests against an older schema fails per "
                    + "request with a bare Npgsql 42703 or 42P01.",
                    name, pending.Count, string.Join(", ", pending));

                return HealthCheckResult.Unhealthy($"{name}: {pending.Count} migration(s) pending");
            }
        }

        return HealthCheckResult.Healthy();
    }
}

/// <summary>
/// <b>This process's own</b> Hangfire server is alive.
/// <para>
/// <b>Registered only when <c>Hangfire:Enabled</c> is true</b>, because a host that switched the
/// job server off did so on purpose — that is how the upload path stays runnable and testable
/// without one — and a readiness check cannot both respect that and assert against it.
/// </para>
/// <para>
/// Without a heartbeat nothing is transcribed, nothing is extracted and no report is sent, while
/// every request still answers 200. That is the same class of lie as an un-migrated schema, which
/// is why it belongs to readiness rather than to a dashboard nobody is looking at.
/// </para>
/// <para>
/// <b>"This process's own" is the correction that makes the check mean anything.</b> The first cut
/// counted <em>any</em> server row with a recent heartbeat. A server row outlives its process by up
/// to Hangfire's five-minute server timeout, so a container that crash-restarted with a job server
/// that failed to start would read the dead server's heartbeat as fresh and call itself ready. In
/// a container the two are easy to confuse for one another: the API is pid 1 in its own namespace
/// and the machine name is the container id, so the restarted process composes the same
/// <c>machine:pid</c> that the corpse did — the trailing GUID Hangfire adds is the only thing that
/// tells them apart, and <see cref="JobServerIdentity"/> is told it rather than guessing it.
/// </para>
/// </summary>
public sealed class JobServerReadyCheck(
    JobStorage storage, JobServerIdentity identity, ILogger<JobServerReadyCheck> logger)
    : IHealthCheck
{
    /// <summary>
    /// Hangfire's own heartbeat interval is 30 s and its server timeout 5 min. Two minutes is
    /// past several missed beats and well short of the timeout that would remove the server.
    /// </summary>
    public static readonly TimeSpan MaxHeartbeatAge = TimeSpan.FromMinutes(2);

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken ct = default)
    {
        var serverId = identity.ServerId;

        if (serverId is null)
        {
            // The job server was configured on and never started: `AddHangfireServer` threw, or
            // the hosted service has not reached its first process yet. Either way this host is
            // not doing the work it is expected to do.
            logger.LogError(
                "Readiness: no Hangfire job server has started in this process. Nothing is being "
                + "transcribed, extracted or reported while requests still answer 200.");

            return Task.FromResult(HealthCheckResult.Unhealthy("no job server in this process"));
        }

        try
        {
            var servers = storage.GetMonitoringApi().Servers();

            var mine = servers.FirstOrDefault(
                server => string.Equals(server.Name, serverId, StringComparison.Ordinal));

            if (mine is null)
            {
                // Announced once and no longer in the table: another server's watchdog removed it
                // after the timeout, or the storage was cleared underneath the process.
                logger.LogError(
                    "Readiness: this process's Hangfire server {JobServerId} is no longer "
                    + "registered ({ServerCount} other server(s) present).",
                    serverId, servers.Count);

                return Task.FromResult(
                    HealthCheckResult.Unhealthy("this process's job server is not registered"));
            }

            if ((mine.Heartbeat ?? mine.StartedAt) <= DateTime.UtcNow - MaxHeartbeatAge)
            {
                logger.LogError(
                    "Readiness: this process's Hangfire server {JobServerId} has not beaten "
                    + "within {MaxAgeSeconds}s. Nothing is being transcribed, extracted or "
                    + "reported while requests still answer 200.",
                    serverId, (int)MaxHeartbeatAge.TotalSeconds);

                return Task.FromResult(HealthCheckResult.Unhealthy("no job server heartbeat"));
            }

            return Task.FromResult(HealthCheckResult.Healthy());
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Readiness: the Hangfire job storage could not be read.");

            return Task.FromResult(HealthCheckResult.Unhealthy("job storage unreadable"));
        }
    }
}

/// <summary>
/// What <c>/health/ready</c> writes.
///
/// <para>
/// <b>Plain text, and the whole body is a fixed vocabulary.</b> The route is unauthenticated — the
/// container healthcheck calls it every fifteen seconds and <c>deploy.sh</c> calls it before
/// anybody has signed in — so nothing derived from an exception, a schema or a query may reach it.
/// A check's <c>description</c> is therefore a <b>public string</b>: it may name the check and the
/// context and may count things, and it may not carry a message, a table name or a migration name.
/// Every one of those goes to the log, which is where a person looking at a failure is anyway.
/// </para>
/// <para>
/// The default writer emits only the word <c>Unhealthy</c>, which answers "is it ready" and
/// nothing about which half is not. One line per failing check is the difference between a deploy
/// that says "run migrate" and a deploy that says "something".
/// </para>
/// </summary>
public static class ReadinessEndpoint
{
    public static Task WriteAsync(HttpContext http, HealthReport report)
    {
        http.Response.ContentType = "text/plain; charset=utf-8";

        var lines = new List<string> { report.Status.ToString() };

        lines.AddRange(report.Entries
            .Where(entry => entry.Value.Status != HealthStatus.Healthy)
            .Select(entry => string.IsNullOrWhiteSpace(entry.Value.Description)
                ? entry.Key
                : $"{entry.Key}: {entry.Value.Description}"));

        return http.Response.WriteAsync(string.Join("\n", lines) + "\n");
    }
}
