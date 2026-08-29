using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Teren.Core.Entities;
using Teren.Core.Ai;
using Teren.Core.Processing;
using Teren.Core.Storage;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Persistence;
using Testcontainers.PostgreSql;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// The whole test rig: one throwaway Postgres 17 container per test run, the real EF migrations
/// applied to it, and the real application booted against it through
/// <see cref="WebApplicationFactory{TEntryPoint}"/>.
/// <para>
/// Postgres and not InMemory because half of what is under test is not in C#: the
/// <c>trg_entry_guard_update/delete</c> triggers, the CHECK constraints, and the unique
/// constraints whose violations the idempotency path translates into answers. Against a fake
/// provider every one of those tests would pass on a broken database.
/// </para>
/// <para>
/// postgres:17-alpine, matching docker-compose.yml — a suite that proves the schema against a
/// different major version proves it about a database nobody runs.
/// </para>
/// </summary>
public sealed class TerenTestApp : IAsyncLifetime
{
    /// <summary>Migrated once, kept empty, and used only as a CREATE DATABASE template so a test
    /// that needs a pristine schema (the seeder) gets one in milliseconds.</summary>
    private const string TemplateDatabase = "teren_template";

    private const string ApiDatabase = "teren_api";

    public const string DeviceToken = "teren-test-device-token-not-a-secret";

    /// <summary>
    /// The presigned-URL lifetime the fixture pins on the host, kept here so assertions about
    /// <c>expires_at</c> can name the number instead of re-deriving it. It is deliberately the
    /// same 15 minutes ARCHITECTURE §8 fixes and <c>StorageOptions</c> defaults to — a fixture
    /// that pinned some other value would let the round-trip test pass while the shipped TTL
    /// was wrong. <c>StorageConfigurationTests</c> is what holds the two together.
    /// </summary>
    public static readonly TimeSpan UploadUrlTtl = TimeSpan.FromMinutes(15);

    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine")
        .WithDatabase("postgres")
        .WithUsername("teren")
        .WithPassword("teren_test_only")
        .Build();

    private WebApplicationFactory<Program>? _factory;
    private int _scratchDatabaseCounter;

    public FakeObjectStorage Storage { get; } = new();

    public FakeTranscriptionProvider Transcription { get; } = new();

    public FakeStructureExtractor Extractor { get; } = new();

    public RecordingPipelineQueue Pipeline { get; } = new();

    public InsertRaceInterceptor RaceInterceptor { get; } = new();

    public string ApiConnectionString { get; private set; } = string.Empty;

    public WebApplicationFactory<Program> Factory =>
        _factory ?? throw new InvalidOperationException("The test app has not been initialised.");

    public async ValueTask InitializeAsync()
    {
        await _postgres.StartAsync();

        await ExecuteOnMaintenanceDatabaseAsync("CREATE DATABASE " + TemplateDatabase);
        await using (var template = CreateDbContext(ConnectionStringFor(TemplateDatabase)))
        {
            // The real migrations, triggers and CHECK constraints included — not EnsureCreated,
            // which builds the model's tables and quietly skips every raw-SQL guard.
            await template.Database.MigrateAsync();
        }

        // A template database must have no other sessions attached when it is copied.
        NpgsqlConnection.ClearAllPools();
        await ExecuteOnMaintenanceDatabaseAsync(
            "CREATE DATABASE " + ApiDatabase + " TEMPLATE " + TemplateDatabase);

        ApiConnectionString = ConnectionStringFor(ApiDatabase);

        // The application reads its connection string, token and storage settings from
        // configuration *before* WebApplicationFactory's hooks can run: Program.cs resolves them
        // against builder.Configuration on the way to Build(). Environment variables are the one
        // source WebApplication.CreateBuilder reads unconditionally, and they outrank
        // appsettings.Development.json, so this is what actually redirects the host.
        Environment.SetEnvironmentVariable("ASPNETCORE_ENVIRONMENT", "Development");
        Environment.SetEnvironmentVariable("ConnectionStrings__Postgres", ApiConnectionString);
        Environment.SetEnvironmentVariable("Auth__DeviceToken", DeviceToken);
        Environment.SetEnvironmentVariable("Auth__CompanyId", TestIds.CompanyA.ToString());
        Environment.SetEnvironmentVariable("Auth__DeviceId", TestIds.DeviceA.ToString());
        Environment.SetEnvironmentVariable("Storage__Endpoint", "http://storage.invalid:9000");
        Environment.SetEnvironmentVariable("Storage__AccessKey", "test");
        Environment.SetEnvironmentVariable("Storage__SecretKey", "test_only");
        Environment.SetEnvironmentVariable("Storage__Bucket", "teren-media");
        Environment.SetEnvironmentVariable(
            "Storage__UploadUrlTtl", UploadUrlTtl.ToString("c"));
        // The floor the options validator allows, so the budget test costs two seconds, not ten.
        Environment.SetEnvironmentVariable("Storage__VerificationBudget", "00:00:02");

        // No Hangfire in the test host. The pipeline's own seams — IPipelineQueue in front of it
        // and EntryProcessor behind it — are what the tests drive, so a job server would only
        // add a schema, a polling loop, and a background thread racing every assertion.
        Environment.SetEnvironmentVariable("Hangfire__Enabled", "false");
        // Serilog is wired for real (a broken sink would still fail startup), but quiet: at
        // Information the suite writes a few thousand lines of application log around the one
        // line that says which test failed.
        Environment.SetEnvironmentVariable("Serilog__MinimumLevel__Default", "Warning");
        // Retries are proven by counting provider calls, not by waiting: zero delay keeps the
        // retry tests instant while still exercising the loop.
        Environment.SetEnvironmentVariable("Pipeline__RetryDelay", "00:00:00");

        _factory = new TerenApplicationFactory(this);

        // Force the host to build now, so a startup failure surfaces as a fixture error rather
        // than as an unrelated first test failing.
        _ = _factory.Services;

        await ResetAsync();
    }

    public async ValueTask DisposeAsync()
    {
        if (_factory is not null)
        {
            await _factory.DisposeAsync();
        }

        NpgsqlConnection.ClearAllPools();
        await _postgres.DisposeAsync();
    }

    // ------------------------------------------------------------------ clients

    public HttpClient CreateClient()
    {
        var client = Factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
        });
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", DeviceToken);
        return client;
    }

    public HttpClient CreateAnonymousClient() =>
        Factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

    // ------------------------------------------------------------------ database

    /// <summary>A context on the API's database. <paramref name="companyId"/> null means the
    /// tenant is unset — which, deny-by-default, is a context that can read nothing.</summary>
    public TerenDbContext CreateDbContext(Guid? companyId) =>
        CreateDbContext(ApiConnectionString, companyId);

    private static TerenDbContext CreateDbContext(string connectionString, Guid? companyId = null)
    {
        var options = new DbContextOptionsBuilder<TerenDbContext>()
            .UseNpgsql(connectionString)
            .Options;

        return new TerenDbContext(options, new TenantContext { CompanyId = companyId });
    }

    /// <summary>
    /// A brand-new database with the schema and nothing in it, cloned from the migrated template.
    /// The seeder tests need a database no other test has touched — that is the only way "a
    /// database at an older seed state gains exactly the missing rows" means anything.
    /// </summary>
    public async Task<TerenDbContext> CreateScratchDatabaseAsync(Guid? companyId = null)
    {
        var name = "teren_scratch_" + Interlocked.Increment(ref _scratchDatabaseCounter);
        await ExecuteOnMaintenanceDatabaseAsync(
            "CREATE DATABASE " + name + " TEMPLATE " + TemplateDatabase);
        return CreateDbContext(ConnectionStringFor(name), companyId);
    }

    /// <summary>
    /// Wipes every row and re-lays the baseline. TRUNCATE, not DELETE, on purpose: the entry
    /// guard trigger rejects DELETE of reported entries, so a suite that cleaned up with DELETE
    /// could not clean up after its own immutability tests.
    /// </summary>
    public async Task ResetAsync()
    {
        Storage.Reset();
        Transcription.Reset();
        Extractor.Reset();
        Pipeline.Reset();
        RaceInterceptor.Disarm();

        await using var db = CreateDbContext(companyId: null);
        await db.Database.ExecuteSqlRawAsync(
            "TRUNCATE TABLE media, report, entry, project, company RESTART IDENTITY CASCADE");

        var now = DateTime.UtcNow;

        db.Companies.AddRange(
            new Company { Id = TestIds.CompanyA, Name = TestIds.CompanyAName, CreatedAt = now },
            new Company { Id = TestIds.CompanyB, Name = "Druga firma d.o.o.", CreatedAt = now });

        db.Projects.AddRange(
            new Project
            {
                Id = TestIds.ProjectA1,
                CompanyId = TestIds.CompanyA,
                Name = "Stambena zgrada Vojvode Stepe 212",
                Address = "Vojvode Stepe 212, Voždovac, Beograd",
                Latitude = 44.7692,
                Longitude = 20.4787,
                ReportLanguage = "sr",
                CreatedAt = now,
            },
            new Project
            {
                Id = TestIds.ProjectA2,
                CompanyId = TestIds.CompanyA,
                Name = "Zgrada B",
                ReportLanguage = "sr",
                CreatedAt = now,
            },
            new Project
            {
                Id = TestIds.ProjectB1,
                CompanyId = TestIds.CompanyB,
                Name = "Gradiliste druge firme",
                ReportLanguage = "sr",
                CreatedAt = now,
            });

        await db.SaveChangesAsync();
    }

    // ------------------------------------------------------------------ plumbing

    private string ConnectionStringFor(string database) =>
        new NpgsqlConnectionStringBuilder(_postgres.GetConnectionString())
        {
            Database = database,
            IncludeErrorDetail = true,
        }.ConnectionString;

    private async Task ExecuteOnMaintenanceDatabaseAsync(string sql)
    {
        await using var connection = new NpgsqlConnection(_postgres.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    private sealed class TerenApplicationFactory(TerenTestApp app) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureTestServices(services =>
            {
                // Storage is faked at the interface the architecture put there for it. Everything
                // in front of it — the auth filter, validation, the handlers, the JSON policy,
                // the exception handlers — is the real thing.
                services.RemoveAll<IObjectStorage>();
                services.AddSingleton<IObjectStorage>(app.Storage);

                // The two external AI services, faked at the interfaces ARCHITECTURE §9 put
                // there for exactly this. No test in this suite makes a real Azure or Anthropic
                // call, and none should: what is under test is the pipeline's behaviour around
                // those calls, which must be provable on a machine with no keys.
                services.RemoveAll<ITranscriptionProvider>();
                services.AddSingleton<ITranscriptionProvider>(app.Transcription);

                services.RemoveAll<IStructureExtractor>();
                services.AddSingleton<IStructureExtractor>(app.Extractor);

                services.RemoveAll<IPipelineQueue>();
                services.AddSingleton<IPipelineQueue>(app.Pipeline);

                // A second AddDbContext contributes another options configuration, applied after
                // the one in Program.cs; the connection string is identical (both come from the
                // environment variable), and this one carries the interceptor that makes the
                // insert race deterministic.
                services.AddDbContext<TerenDbContext>(options => options
                    .UseNpgsql(app.ApiConnectionString)
                    .AddInterceptors(app.RaceInterceptor));
            });
        }
    }
}

/// <summary>
/// Everything runs in one collection, and therefore sequentially. The tests share one database
/// and one set of process-wide environment variables; parallel classes would make truncation
/// between tests a race rather than a reset. The container start is the only slow part, and it
/// is paid once.
/// </summary>
[CollectionDefinition(Name)]
public sealed class TerenCollection : ICollectionFixture<TerenTestApp>
{
    public const string Name = "teren";
}
