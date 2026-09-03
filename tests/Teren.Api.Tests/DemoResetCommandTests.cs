using Microsoft.Extensions.Options;
using Teren.Infrastructure.Tenancy;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Teren.Api.Maintenance;
using Teren.Api.Tests.Infrastructure;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// <c>reset-demo</c> driven end to end as the terminal does, against a database at the state a
/// founder laptop or staging box is actually in.
/// <para>
/// The case that matters is the <b>un-migrated</b> one. This command is what gets reached for when
/// the demo is broken and a customer is in the room, and its safe default — no flag, report what
/// would be destroyed, touch nothing — used to die on a bare Npgsql
/// <c>42P01 relation "app_user" does not exist</c> with a stack trace, because it migrated only
/// one of the two histories. CLAUDE.md records that exact failure shape as having bitten twice
/// already; a command whose own comment explains that it migrates first should not be the third.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class DemoResetCommandTests(TerenTestApp app)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_dry_run_against_a_pre_identity_database_migrates_rather_than_dying()
    {
        // The safe default: `reset-demo` with no flag. It must survive a database that has never
        // seen the identity schema, and leave it migrated.
        var connectionString = await app.CreatePreIdentityDatabaseAsync();
        await AssertNoIdentitySchemaAsync(connectionString);

        var exitCode = await RunAsync(
            connectionString, "Development", [DemoResetGuard.CommandName]);

        // A dry run that was asked for a reset and did not perform one reports non-zero, so a
        // script can tell. What matters here is that it got that far at all.
        // 2, not 0: it was asked for a reset and did not perform one, so a script can tell.
        // The point of the test is that it got this far at all rather than throwing 42P01.
        exitCode.ShouldBe(2);

        await AssertIdentitySchemaPresentAsync(connectionString);
    }

    [Fact]
    public async Task A_real_reset_against_a_pre_identity_database_seeds_a_usable_demo()
    {
        var connectionString = await app.CreatePreIdentityDatabaseAsync();

        var exitCode = await RunAsync(
            connectionString,
            "Development",
            [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag]);

        exitCode.ShouldBe(0);

        await using var db = CreateContext(connectionString);

        // Not merely "the tables exist": the demo that comes out of it has its people and a phone.
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM app_user")).ShouldBe(2);
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM device")).ShouldBe(1);
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM project")).ShouldBe(3);
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM entry")).ShouldBe(3);
    }

    [Fact]
    public async Task A_refused_host_still_never_touches_the_database()
    {
        // The guard refuses before it reads, and that has to stay true now that the command
        // migrates two histories rather than one: a production box must not be migrated by a
        // command it is not allowed to run.
        var connectionString = await app.CreatePreIdentityDatabaseAsync();

        var exitCode = await RunAsync(
            connectionString,
            "Production",
            [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag]);

        exitCode.ShouldNotBe(0);
        await AssertNoIdentitySchemaAsync(connectionString);
    }

    [Fact]
    public async Task Resetting_an_already_migrated_database_still_works()
    {
        // The ordinary case, so the fix above cannot have been bought by breaking it.
        await using var scratch = await app.CreateScratchDatabaseAsync();
        var connectionString = scratch.Database.GetConnectionString()!;
        await DemoSeeder.SeedAsync(scratch, TerenTestApp.DeviceToken, useFixedDemoCode: true, Ct);

        var exitCode = await RunAsync(
            connectionString,
            "Development",
            [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag]);

        exitCode.ShouldBe(0);
        (await CountAsync(scratch, "SELECT count(*)::int AS \"Value\" FROM device")).ShouldBe(1);
    }

    [Fact]
    public async Task A_Development_reset_puts_the_published_code_back()
    {
        // The laptop case, unchanged by the 2026-09-03 decision and pinned so it stays that way:
        // `reset-demo` is what the founder reaches for when a demo has been given, and what comes
        // out of it has to be the code docs/demo-script.md and the demo film both name.
        await using var scratch = await app.CreateScratchDatabaseAsync();
        var connectionString = scratch.Database.GetConnectionString()!;

        var exitCode = await RunAsync(
            connectionString,
            "Development",
            [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag]);

        exitCode.ShouldBe(0);
        (await LiveCodeDisplayAsync(scratch)).ShouldBe(DemoSeeder.DemoActivationCodeDisplay);
    }

    [Fact]
    public async Task A_reset_enabled_non_Development_host_does_not_get_the_published_code()
    {
        // **The hole this closed.** `reset-demo` is refused outside Development *unless*
        // Demo:ResetEnabled says otherwise — a documented, supported configuration for a deployed
        // demo box. The re-seed used to ask for the published code unconditionally, so the one
        // command a founder reaches for to fix the demo on that box would have put the
        // repository's credential straight back, minutes after `seed` had kept it off.
        await using var scratch = await app.CreateScratchDatabaseAsync();
        var connectionString = scratch.Database.GetConnectionString()!;

        var exitCode = await RunAsync(
            connectionString,
            "Demo",
            [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag],
            resetEnabled: true);

        exitCode.ShouldBe(0);

        var live = await LiveCodeDisplayAsync(scratch);

        // A code, and not that one: a reset that left the demo unjoinable would defeat the point
        // of the command just as thoroughly.
        live.ShouldNotBeNull();
        live.ShouldNotBe(DemoSeeder.DemoActivationCodeDisplay);
        Teren.Core.Identity.ActivationCodeFormat.TryParse(live, out _).ShouldBeTrue();
    }

    // ---------------------------------------------------------------- harness

    private static async Task<string?> LiveCodeDisplayAsync(DbContext db) =>
        (await db.Database.SqlQueryRaw<string?>(
            """
            SELECT code_display AS "Value" FROM activation_code
             WHERE user_id = {0} AND consumed_at IS NULL AND superseded_at IS NULL
               AND expires_at > now()
            """,
            DemoSeeder.WorkerId).ToListAsync(Ct))
        .SingleOrDefault();

    /// <summary>
    /// Builds the smallest host the command needs — both DbContexts, wired exactly as Program.cs
    /// wires them — and runs the real <see cref="DemoResetCommand.RunAsync"/>. Nothing about the
    /// migrate step is re-implemented here; if it were, the test would prove only that the test
    /// can migrate.
    /// <para>
    /// The environment is always passed explicitly. An earlier convenience overload that defaulted
    /// it silently bound the command word into <c>environment</c> and left <c>args</c> empty, so
    /// every call was refused for the wrong reason — and a refusal looks a lot like the failure
    /// these tests exist to catch.
    /// </para>
    /// </summary>
    private static async Task<int> RunAsync(
        string connectionString, string environment, string[] args, bool resetEnabled = false)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environment,
        });

        // The setting that makes this command runnable on a host that is not Development. It is
        // the whole reason the demo code's Development gate has to be read from the environment
        // here rather than assumed from "the guard let me through".
        builder.Configuration.AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                [DemoResetGuard.EnabledSetting] = resetEnabled ? "true" : "false",
            });

        builder.Services.AddScoped<Teren.Core.Tenancy.TenantContext>();

        // The command reads the demo device token from here, exactly as Program.cs does. Leaving
        // it unregistered would give an empty token and a demo with no phone — which is precisely
        // the state the command now says out loud rather than swallowing.
        builder.Services.Configure<DeviceAuthOptions>(
            o => o.DeviceToken = TerenTestApp.DeviceToken);
        builder.Services.AddDbContext<TerenDbContext>(
            (Action<DbContextOptionsBuilder>)(o => o.UseNpgsql(connectionString)));
        builder.Services.AddDbContext<TerenIdentityDbContext>(
            (Action<DbContextOptionsBuilder>)(o => o
                .UseNpgsql(connectionString, npgsql => npgsql
                    .MigrationsHistoryTable(TerenIdentityDbContext.MigrationsHistoryTable))));

        await using var host = builder.Build();

        // Neither purge is registered, exactly as on a host started without `reset-demo` having
        // reached the container — the command reports them as unavailable rather than failing.
        return await DemoResetCommand.RunAsync(host, args);
    }

    private static TerenDbContext CreateContext(string connectionString) =>
        new(
            new DbContextOptionsBuilder<TerenDbContext>().UseNpgsql(connectionString).Options,
            new Teren.Core.Tenancy.TenantContext());

    private static async Task AssertNoIdentitySchemaAsync(string connectionString)
    {
        await using var db = CreateContext(connectionString);

        (await CountAsync(db, TableExists("app_user"))).ShouldBe(0);
        (await CountAsync(db, TableExists("device"))).ShouldBe(0);
    }

    private static async Task AssertIdentitySchemaPresentAsync(string connectionString)
    {
        await using var db = CreateContext(connectionString);

        (await CountAsync(db, TableExists("app_user"))).ShouldBe(1);
        (await CountAsync(db, TableExists("device"))).ShouldBe(1);
        (await CountAsync(db, TableExists("activation_code"))).ShouldBe(1);
    }

    private static string TableExists(string table) =>
        $"""
         SELECT count(*)::int AS "Value" FROM pg_tables
         WHERE schemaname = 'public' AND tablename = '{table}'
         """;

    private static async Task<int> CountAsync(DbContext db, string sql) =>
        (await db.Database.SqlQueryRaw<int>(sql).ToListAsync(Ct)).Single();
}
