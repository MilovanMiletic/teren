using Hangfire;
using Hangfire.Server;
using Hangfire.Storage;
using Hangfire.Storage.Monitoring;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging.Abstractions;
using Teren.Api.Health;
using Teren.Api.Tests.Infrastructure;

namespace Teren.Api.Tests;

/// <summary>
/// <c>/health/ready</c>'s job-server check, and the defect it used to have.
///
/// <para>
/// <b>The check counted any server row with a recent heartbeat.</b> Hangfire's server timeout is
/// five minutes, so a row outlives its process by up to that long — which means a container that
/// crash-restarted with a job server that failed to start would read the <em>dead</em> server's
/// heartbeat, find it fresh, and report itself ready. For as long as the corpse lived, readiness
/// asserted that background work was happening while nothing was being transcribed, extracted or
/// reported.
/// </para>
///
/// <para>
/// <b>And "it is a different process, so it will have a different name" is not true in a
/// container.</b> Hangfire composes the default server name from the machine name and the process
/// id; in a container the API is pid 1 in its own namespace and the machine name is the container
/// id, so a restarted process composes the same <c>machine:pid</c> prefix the dead one had. Only
/// the trailing GUID separates them — which is why <see cref="JobServerIdentity"/> is <em>told</em>
/// the id by Hangfire rather than reconstructing it. (The shape was read off a live
/// <c>hangfire.server</c> row: <c>desktop-i9cc3fv:35160:240e5f47-…</c>. Nothing here parses it.)
/// </para>
///
/// <para>
/// <b>These run without a job server, deliberately.</b> The suite sets
/// <c>Hangfire__Enabled=false</c> — that switch is what keeps the whole upload path runnable and
/// testable without a background worker, and the readiness check is not even registered on such a
/// host. So the check is exercised directly against a storage stub, which is also the only way to
/// stage a heartbeat that is two minutes old without waiting two minutes. What the shipped host
/// does with it is <see cref="HealthTests"/>' and <see cref="ReadinessTests"/>' job.
/// </para>
/// </summary>
public sealed class JobServerReadinessTests
{
    private const string Mine = "container-a1b2c3:1:1e2d3c4b-0000-0000-0000-000000000001";
    private const string Corpse = "container-a1b2c3:1:9f8e7d6c-0000-0000-0000-000000000002";

    [Fact]
    public async Task A_fresh_heartbeat_belonging_to_a_dead_server_is_not_this_host_being_ready()
    {
        // THE REGRESSION. One row, beating thirty seconds ago, and it is not ours: the process
        // that wrote it is gone and this process's job server never started. The old check
        // counted it and answered Healthy.
        var identity = new JobServerIdentity();
        identity.Announce(Mine);

        var result = await CheckAsync(
            identity, Server(Corpse, heartbeat: DateTime.UtcNow.AddSeconds(-30)));

        result.Status.ShouldBe(HealthStatus.Unhealthy);
        result.Description.ShouldBe("this process's job server is not registered");
    }

    [Fact]
    public async Task A_process_whose_job_server_never_started_is_not_ready()
    {
        // `Hangfire:Enabled` is true (or this check would not be registered) and yet nothing in
        // this process ever announced itself: AddHangfireServer threw, or the hosted service has
        // not reached its first process. Either way the host is not doing the work it is expected
        // to do, and it must not say otherwise — the storage is not even read, because the answer
        // does not depend on it.
        var result = await new JobServerReadyCheck(
                storage: null!,
                new JobServerIdentity(),
                NullLogger<JobServerReadyCheck>.Instance)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        result.Status.ShouldBe(HealthStatus.Unhealthy);
        result.Description.ShouldBe("no job server in this process");
    }

    [Fact]
    public async Task This_process_beating_alongside_other_servers_is_ready()
    {
        // The positive control, and it carries the second half of the point: other servers in the
        // table are none of this check's business. A second container is a normal thing and must
        // neither rescue nor condemn this one.
        var identity = new JobServerIdentity();
        identity.Announce(Mine);

        var result = await CheckAsync(
            identity,
            Server(Corpse, heartbeat: DateTime.UtcNow.AddSeconds(-10)),
            Server(Mine, heartbeat: DateTime.UtcNow.AddSeconds(-5)));

        result.Status.ShouldBe(HealthStatus.Healthy);
    }

    [Fact]
    public async Task This_process_registered_but_no_longer_beating_is_not_ready()
    {
        // Our own row, stale. The worker thread is wedged or the process cannot reach storage;
        // requests still answer 200 and nothing is being processed, which is the same class of lie
        // as an un-migrated schema.
        var identity = new JobServerIdentity();
        identity.Announce(Mine);

        var stale = DateTime.UtcNow - JobServerReadyCheck.MaxHeartbeatAge - TimeSpan.FromSeconds(1);

        var result = await CheckAsync(identity, Server(Mine, heartbeat: stale));

        result.Status.ShouldBe(HealthStatus.Unhealthy);
        result.Description.ShouldBe("no job server heartbeat");
    }

    [Fact]
    public async Task A_server_that_has_beaten_but_never_reported_one_falls_back_to_its_start()
    {
        // Hangfire writes the heartbeat after the first interval, so a server that started two
        // seconds ago legitimately has none. StartedAt is the honest stand-in and the window is
        // the same.
        var identity = new JobServerIdentity();
        identity.Announce(Mine);

        var result = await CheckAsync(
            identity,
            new ServerDto
            {
                Name = Mine,
                Heartbeat = null,
                StartedAt = DateTime.UtcNow.AddSeconds(-2),
            });

        result.Status.ShouldBe(HealthStatus.Healthy);
    }

    [Fact]
    public async Task Storage_that_cannot_be_read_is_not_ready_and_says_so_without_detail()
    {
        var identity = new JobServerIdentity();
        identity.Announce(Mine);

        var result = await new JobServerReadyCheck(
                new StubStorage(new ThrowingMonitoringApi()),
                identity,
                NullLogger<JobServerReadyCheck>.Instance)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        result.Status.ShouldBe(HealthStatus.Unhealthy);

        // The route is public: the exception goes to the log, never to the body.
        result.Description.ShouldBe("job storage unreadable");
    }

    [Fact]
    public void The_announcement_records_the_id_hangfire_hands_this_process()
    {
        // The whole mechanism, and it is deliberately three lines: nothing composes or parses a
        // server id anywhere in this repository.
        var identity = new JobServerIdentity();
        identity.ServerId.ShouldBeNull();

        using var stopped = new CancellationTokenSource();
        stopped.Cancel();

        // Cancelled up front so `Wait` returns immediately instead of parking for five minutes.
        // The four-argument overload is [Obsolete] in 1.8; this is the one Hangfire itself uses.
        var context = new BackgroundProcessContext(
            Mine,
            new StubStorage(new ThrowingMonitoringApi()),
            new Dictionary<string, object>(),
            Guid.NewGuid(),
            stopped.Token,
            stopped.Token,
            stopped.Token);

        // The id is recorded first and the process then parks until shutdown. `Wait` on an
        // already-cancelled token throws, which is Hangfire's own convention for "the server is
        // stopping" — its ServerWatchdog does exactly the same and does not catch it either.
        Should.Throw<OperationCanceledException>(() =>
            new JobServerAnnouncement(identity, NullLogger<JobServerAnnouncement>.Instance)
                .Execute(context));

        identity.ServerId.ShouldBe(
            Mine, "the id must be written down before the process parks, or a shutdown during "
            + "start-up would leave readiness with nothing to compare against");
    }

    // ---------------------------------------------------------------------------------- helpers

    private static Task<HealthCheckResult> CheckAsync(
        JobServerIdentity identity, params ServerDto[] servers) =>
        new JobServerReadyCheck(
                new StubStorage(new ServerListMonitoringApi(servers)),
                identity,
                NullLogger<JobServerReadyCheck>.Instance)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

    private static ServerDto Server(string name, DateTime heartbeat) =>
        new() { Name = name, Heartbeat = heartbeat, StartedAt = heartbeat.AddMinutes(-10) };

    private sealed class StubStorage(IMonitoringApi api) : JobStorage
    {
        public override IMonitoringApi GetMonitoringApi() => api;

        public override IStorageConnection GetConnection() => throw new NotSupportedException();
    }

    /// <summary>
    /// The one method the readiness check calls. Everything else throws, so a check that started
    /// asking the storage something else would fail loudly here rather than quietly pass.
    /// </summary>
    private sealed class ServerListMonitoringApi(ServerDto[] servers) : ThrowingMonitoringApi
    {
        public override IList<ServerDto> Servers() => servers;
    }

    private class ThrowingMonitoringApi : IMonitoringApi
    {
        public virtual IList<ServerDto> Servers() => throw new InvalidOperationException("storage");

        public IList<QueueWithTopEnqueuedJobsDto> Queues() => throw new NotSupportedException();

        public JobDetailsDto JobDetails(string jobId) => throw new NotSupportedException();

        public StatisticsDto GetStatistics() => throw new NotSupportedException();

        public JobList<EnqueuedJobDto> EnqueuedJobs(string queue, int from, int perPage) =>
            throw new NotSupportedException();

        public JobList<FetchedJobDto> FetchedJobs(string queue, int from, int perPage) =>
            throw new NotSupportedException();

        public JobList<ProcessingJobDto> ProcessingJobs(int from, int count) =>
            throw new NotSupportedException();

        public JobList<ScheduledJobDto> ScheduledJobs(int from, int count) =>
            throw new NotSupportedException();

        public JobList<SucceededJobDto> SucceededJobs(int from, int count) =>
            throw new NotSupportedException();

        public JobList<FailedJobDto> FailedJobs(int from, int count) =>
            throw new NotSupportedException();

        public JobList<DeletedJobDto> DeletedJobs(int from, int count) =>
            throw new NotSupportedException();

        public long ScheduledCount() => throw new NotSupportedException();

        public long EnqueuedCount(string queue) => throw new NotSupportedException();

        public long FetchedCount(string queue) => throw new NotSupportedException();

        public long FailedCount() => throw new NotSupportedException();

        public long ProcessingCount() => throw new NotSupportedException();

        public long SucceededListCount() => throw new NotSupportedException();

        public long DeletedListCount() => throw new NotSupportedException();

        public IDictionary<DateTime, long> SucceededByDatesCount() =>
            throw new NotSupportedException();

        public IDictionary<DateTime, long> FailedByDatesCount() => throw new NotSupportedException();

        public IDictionary<DateTime, long> HourlySucceededJobs() => throw new NotSupportedException();

        public IDictionary<DateTime, long> HourlyFailedJobs() => throw new NotSupportedException();
    }
}
