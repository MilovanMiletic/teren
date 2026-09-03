using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Teren.Api.Health;
using Teren.Api.Tests.Infrastructure;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Tests;

/// <summary>
/// <c>/health/ready</c> against databases that are <b>not</b> ready.
///
/// <para>
/// <b>Why these run on a minimal host of their own rather than on the fixture's.</b> Booting a
/// second copy of <c>Program</c> in this process would hijack logging for the whole run:
/// <c>UseSerilog</c> without <c>preserveStaticLogger</c> assigns the logger it builds to Serilog's
/// <em>static</em> <c>Log.Logger</c>, so a second host silently repoints every subsequent log call
/// — from the first host included — at its own sink, and disposing it leaves a disposed logger
/// behind. The first draft of this file did exactly that and turned
/// <c>AppLogIngressTests.An_anonymous_caller_cannot_write_his_own_words_into_the_log</c> red with
/// an empty log table, one test class away and for no visible reason.
/// </para>
/// <para>
/// What is on the minimal host is everything this test is about and nothing else: the <b>real</b>
/// <see cref="MigrationsReadyCheck"/> and <see cref="DatabaseReadyCheck"/> over real half-migrated
/// databases, the real <c>MapHealthChecks</c> wiring, and the real
/// <see cref="ReadinessEndpoint.WriteAsync"/>. That the shipped host registers the same three
/// checks is <c>HealthTests</c>' job (it asks the route and gets <c>Healthy</c>).
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class ReadinessTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task Ready_is_503_when_the_migrations_were_never_applied()
    {
        // THE FAILURE THIS ROUTE EXISTS FOR: a host started without `migrate`. It boots, answers
        // /health with `ok`, and then dies per request on a bare Npgsql 42703 or 42P01 —
        // CLAUDE.md records it biting twice, once silently killing the money path. This database
        // is migrated only as far as the last pre-D1 migration, so both histories are behind.
        using var host = await HostOnAsync(await App.CreatePreIdentityDatabaseAsync());
        using var client = host.GetTestClient();

        var response = await client.GetAsync("/health/ready", Ct);

        response.StatusCode.ShouldBe(
            HttpStatusCode.ServiceUnavailable,
            "an un-migrated host must not report itself ready — deploy.sh and the container "
            + "healthcheck both ask this route, and both would otherwise pass a host that cannot "
            + "serve a request");

        var body = await response.Content.ReadAsStringAsync(Ct);

        // Plain text, and it names the check, so a deploy can say "run migrate" rather than
        // "something".
        response.Content.Headers.ContentType?.MediaType.ShouldBe("text/plain");
        body.ShouldContain("Unhealthy", Case.Sensitive);
        body.ShouldContain(ReadinessChecks.Migrations, Case.Sensitive);

        // THE EXACT SHAPE deploy/README.md §8 tells an operator to expect, because a runbook that
        // quotes a line the box does not print sends somebody looking for the wrong string. It
        // used to quote `migrations: N migration(s) pending` and omit both the `Unhealthy` first
        // line and the context name.
        var lines = body.TrimEnd('\n').Split('\n');

        lines[0].ShouldBe("Unhealthy", "the status is the first line and nothing else is on it");
        lines.ShouldContain(
            line => line.StartsWith($"{ReadinessChecks.Migrations}: {nameof(TerenDbContext)}: ",
                        StringComparison.Ordinal)
                    && line.EndsWith(" migration(s) pending", StringComparison.Ordinal),
            "deploy/README.md §8 quotes this line verbatim");

        // And nothing else. The route is unauthenticated — the container calls it every fifteen
        // seconds, before anybody has signed in — so the schema, the migration names and any
        // exception text stay in the log.
        foreach (var leak in new[] { "__EFMigrationsHistory", "Npgsql", "42P01", "app_user", "SELECT" })
        {
            body.ShouldNotContain(
                leak,
                Case.Insensitive,
                $"the public readiness body carries '{leak}'. Detail belongs in the log.");
        }
    }

    [Fact]
    public async Task Ready_is_503_when_only_the_identity_history_is_missing()
    {
        // THE HALF A ONE-CONTEXT CHECK WOULD CALL READY. Since D1 there are two histories —
        // __EFMigrationsHistory and __EFMigrationsHistory_identity — and the D1 review found
        // `reset-demo` applying only one and dying on the other's absence. Here the evidence
        // schema is complete and the identity model has never been migrated: no app_user, no
        // device, no app_log, so every login, every bearer token and the whole log viewer are
        // broken while the entry tables are perfect.
        using var host = await HostOnAsync(await App.CreateEvidenceOnlyDatabaseAsync());
        using var client = host.GetTestClient();

        var response = await client.GetAsync("/health/ready", Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);

        var body = await response.Content.ReadAsStringAsync(Ct);
        body.ShouldContain(ReadinessChecks.Migrations, Case.Sensitive);
        body.ShouldContain(
            nameof(TerenIdentityDbContext),
            Case.Sensitive,
            "the failing context is named, so a deploy knows which of the two histories is behind");
    }

    [Fact]
    public async Task Ready_is_503_when_the_database_cannot_be_reached_at_all()
    {
        // The other half of readiness, and the reason it is a query rather than a connection
        // check: a host whose database is gone answers /health with `ok` for as long as the
        // process lives.
        using var host = await HostOnAsync(
            "Host=127.0.0.1;Port=1;Database=nothing;Username=nobody;Password=nothing;"
            + "Timeout=2;Command Timeout=2");
        using var client = host.GetTestClient();

        var response = await client.GetAsync("/health/ready", Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);

        var body = await response.Content.ReadAsStringAsync(Ct);
        body.ShouldContain(ReadinessChecks.Database, Case.Sensitive);
        body.ShouldNotContain("Password", Case.Insensitive, "a connection string never leaks");
    }

    [Fact]
    public async Task Ready_is_200_and_says_nothing_more_when_everything_is_applied()
    {
        // The positive control on the same rig, so the two 503s above cannot be an artefact of
        // the rig itself.
        using var host = await HostOnAsync(App.ApiConnectionString);
        using var client = host.GetTestClient();

        var response = await client.GetAsync("/health/ready", Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);

        var body = (await response.Content.ReadAsStringAsync(Ct)).Trim();

        // One word. A healthy check's name is not in the body — there is nothing to say about a
        // check that passed, and a readiness route is read by a script.
        body.ShouldBe("Healthy");
    }

    /// <summary>
    /// The two database checks and the endpoint wiring, over one connection string, on a host that
    /// does not touch Serilog's static logger. Deliberately does NOT register the Hangfire check:
    /// there is no job server here, and the shipped host registers it only where one is expected.
    /// </summary>
    private static async Task<IHost> HostOnAsync(string connectionString)
    {
        var host = new HostBuilder()
            .ConfigureWebHost(web => web
                .UseTestServer()
                .ConfigureServices(services =>
                {
                    // TerenDbContext takes a TenantContext: its query filters are deny-by-default,
                    // and an unset tenant reads nothing. Nothing here reads a tenant table.
                    services.AddScoped<Teren.Core.Tenancy.TenantContext>();

                    services.AddDbContext<TerenDbContext>(options => options
                        .UseNpgsql(connectionString));
                    services.AddDbContext<TerenIdentityDbContext>(options => options
                        .UseNpgsql(connectionString, npgsql => npgsql
                            .MigrationsHistoryTable(TerenIdentityDbContext.MigrationsHistoryTable)));

                    services.AddHealthChecks()
                        .AddCheck<DatabaseReadyCheck>(ReadinessChecks.Database)
                        .AddCheck<MigrationsReadyCheck>(ReadinessChecks.Migrations);
                })
                .Configure(builder =>
                {
                    builder.UseRouting();
                    builder.UseEndpoints(endpoints =>
                    endpoints.MapHealthChecks("/health/ready", new HealthCheckOptions
                    {
                        ResponseWriter = ReadinessEndpoint.WriteAsync,
                    }));
                })
                .ConfigureServices(services => services.AddRouting()))
            .Build();

        await host.StartAsync(Ct);
        return host;
    }
}
