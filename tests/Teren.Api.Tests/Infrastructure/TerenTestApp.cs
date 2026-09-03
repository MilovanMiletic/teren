using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Teren.Api.Auth;
using Teren.Api.Jobs;
using Teren.Core.Mail;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Ai;
using Teren.Core.Processing;
using Teren.Core.Reporting;
using Teren.Core.Storage;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Reporting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
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
    private int _clientIpCounter;

    public FakeObjectStorage Storage { get; } = new();

    public FakeTranscriptionProvider Transcription { get; } = new();

    public FakeStructureExtractor Extractor { get; } = new();

    public RecordingPipelineQueue Pipeline { get; } = new();

    public FakeReportDelivery Delivery { get; } = new();

    /// <summary>
    /// The transactional mail relay — invites, worker activation codes — stopped at the
    /// <c>IMailSender</c> seam.
    /// <para>
    /// The container held the real <c>SmtpMailSender</c> until 2026-09-02, which meant
    /// <c>IsConfigured</c> was whatever <c>Reporting__Smtp__Host</c> happened to be (true), and the
    /// no-relay branch of every route that asks was untestable. Nothing in this suite ever sent
    /// through it — every mailing job is driven directly — so replacing it costs no coverage and
    /// buys the other half of that question.
    /// </para>
    /// </summary>
    public CapturingMailSender Mail { get; } = new();

    /// <summary>The real QuestPDF renderer with the model it was given recorded. Real on purpose:
    /// the PDF is the product's face, and a stub would leave the licence declaration, the Serbian
    /// glyph check and the whole layout untested behind a green suite.</summary>
    public RecordingReportRenderer Renderer { get; } = new(
        Options.Create(new ReportingOptions()),
        NullLogger<QuestPdfReportRenderer>.Instance);

    /// <summary>The health page's queue reading, substitutable — see
    /// <see cref="FakeJobQueueDepth"/> for why the disabled container answer is not enough.</summary>
    public FakeJobQueueDepth Queue { get; } = new();

    /// <summary>
    /// What the handlers asked the mail-job queue for. Substituted because
    /// <c>DisabledInviteQueue</c> — the real registration on a host with Hangfire off — makes a
    /// request for a job unobservable, which left §13.6's access notice provable only by reading
    /// the code. Its answer to <c>EnqueueInvite</c> stays false by default, so nothing that already
    /// asserts <c>emailed: false</c> changes.
    /// </summary>
    public RecordingInviteQueue Invites { get; } = new();

    public InsertRaceInterceptor RaceInterceptor { get; } = new();

    /// <summary>Records the statement sequence a request issues — see
    /// <see cref="ActivationStatementShapeTests"/>, which is the deterministic half of the
    /// timing-oracle guard.</summary>
    public CommandTapInterceptor CommandTap { get; } = new();

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

        await using (var identityTemplate =
            CreateIdentityDbContext(ConnectionStringFor(TemplateDatabase)))
        {
            // The second history. Both models are migrated into the template, in this order,
            // because device.company_id and app_user.company_id reference the company table the
            // evidence model owns.
            await identityTemplate.Database.MigrateAsync();
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
        Environment.SetEnvironmentVariable("Storage__Endpoint", "http://storage.invalid:9000");
        Environment.SetEnvironmentVariable("Storage__AccessKey", "test");
        Environment.SetEnvironmentVariable("Storage__SecretKey", "test_only");
        Environment.SetEnvironmentVariable("Storage__Bucket", "teren-media");
        Environment.SetEnvironmentVariable(
            "Storage__UploadUrlTtl", UploadUrlTtl.ToString("c"));
        // The floor the options validator allows, so the budget test costs two seconds, not ten.
        Environment.SetEnvironmentVariable("Storage__VerificationBudget", "00:00:02");
        // Same trick for the media read budget: the floor, so the test that proves slow storage
        // becomes a 503 costs two seconds rather than twenty.
        Environment.SetEnvironmentVariable("Storage__MediaReadBudget", "00:00:02");

        // B6. The relay itself is faked, but everything in front of it is real — including the
        // options binding, so a range the validator would refuse fails the fixture rather than
        // one unlucky test.
        Environment.SetEnvironmentVariable("Reporting__FromAddress", "izvestaj@teren.test");
        Environment.SetEnvironmentVariable("Reporting__FromName", "Teren");
        Environment.SetEnvironmentVariable("Reporting__Smtp__Host", "mail.invalid");
        // The floor the options validator allows, so the render-budget test costs two seconds
        // rather than five minutes. Same trick, and same justification, as Storage__VerificationBudget.
        Environment.SetEnvironmentVariable("Reporting__RenderBudget", "00:00:02");

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

        // D5. The database log sink is REAL in the suite — a broken sink must fail here rather
        // than on the founder's laptop — but its background flusher is pushed out of the way so
        // that what reaches `app_log` is deterministic: a test enqueues, calls FlushLogsAsync,
        // and reads. A two-second timer would otherwise write another test's lines into the
        // middle of an assertion.
        Environment.SetEnvironmentVariable("Logging__FlushInterval", "01:00:00");

        // D2. Two things ride on this, and both are deliberate.
        //
        //   * It is what staging and production actually run (deploy/docker-compose.prod.yml puts
        //     Caddy in front), so the suite now exercises the shipped configuration rather than
        //     only the developer one. UseForwardedHeaders with no headers present is a no-op, so
        //     nothing that existed before this line changes.
        //   * It is the only way to give each test client its own rate-limiter partition. The
        //     /auth/* limiter partitions on RemoteIpAddress, which a TestServer request does not
        //     otherwise have — every test in the run would share one bucket of ten attempts and
        //     the suite would start refusing its own logins. CreateAnonymousClient stamps a
        //     distinct X-Forwarded-For per client; AuthRateLimitTests deliberately reuses one.
        Environment.SetEnvironmentVariable("Hosting__BehindProxy", "true");

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
        var client = CreateAnonymousClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", DeviceToken);
        return client;
    }

    /// <summary>
    /// A client presenting an arbitrary bearer token. Needed now that a token resolves to a row
    /// rather than to configuration: a second device with a second token is the only way to prove
    /// the authenticator is a lookup and not a constant.
    /// </summary>
    public HttpClient CreateClientWithToken(string token)
    {
        var client = CreateAnonymousClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    /// <summary>
    /// A client with no credential, and — unless one is named — <b>its own client IP</b>.
    /// <para>
    /// The address matters because the <c>/auth/*</c> rate limiter partitions on it. Ten attempts
    /// per five minutes is the shipped default and is deliberately not raised for the suite: a
    /// limit that only exists in production is a limit nothing proves. Giving each client its own
    /// partition is what lets the real numbers stay in place while forty tests sign in.
    /// <see cref="AuthRateLimitTests"/> passes an explicit address precisely so that two requests
    /// land in the same bucket.
    /// </para>
    /// </summary>
    public HttpClient CreateAnonymousClient(string? clientIp = null)
    {
        var client = Factory.CreateClient(
            new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "X-Forwarded-For", clientIp ?? NextClientIp());

        return client;
    }

    /// <summary>
    /// A fresh address out of the 24-bit private range, so no two clients in a run collide. Wide
    /// enough that the counter cannot wrap inside one suite; 10.x rather than a documentation
    /// range because it is unmistakably synthetic.
    /// </summary>
    public string NextClientIp()
    {
        var n = Interlocked.Increment(ref _clientIpCounter);

        return $"10.{(n >> 16) & 0xFF}.{(n >> 8) & 0xFF}.{n & 0xFF}";
    }

    // ------------------------------------------------------------------ database

    /// <summary>A context on the API's database. <paramref name="companyId"/> null means the
    /// tenant is unset — which, deny-by-default, is a context that can read nothing.</summary>
    public TerenDbContext CreateDbContext(Guid? companyId) =>
        CreateDbContext(ApiConnectionString, companyId);

    private static TerenDbContext CreateDbContext(
        string connectionString,
        Guid? companyId = null,
        params Microsoft.EntityFrameworkCore.Diagnostics.IInterceptor[] interceptors)
    {
        var options = new DbContextOptionsBuilder<TerenDbContext>()
            .UseNpgsql(connectionString)
            .AddInterceptors(interceptors)
            .Options;

        return new TerenDbContext(options, new TenantContext { CompanyId = companyId });
    }

    /// <summary>
    /// A context on the API's identity model. It carries no tenant, because it has no query
    /// filters at all — that is the property that lets the credential authenticator resolve a
    /// token before any company is known.
    /// </summary>
    public TerenIdentityDbContext CreateIdentityDbContext() =>
        CreateIdentityDbContext(ApiConnectionString);

    // ------------------------------------------------------------------ logging

    /// <summary>The one queue the sink and <c>POST /api/client-events</c> both feed.</summary>
    public Teren.Infrastructure.Logging.AppLogQueue LogQueue =>
        Factory.Services.GetRequiredService<Teren.Infrastructure.Logging.AppLogQueue>();

    /// <summary>
    /// Writes whatever is queued, now, and hands back how many rows landed. The suite's flush
    /// interval is an hour, so this is the only thing that moves a log line into the table —
    /// which is what makes a log assertion about the test that wrote it and nothing else.
    /// </summary>
    public Task<int> FlushLogsAsync(CancellationToken ct = default) =>
        Factory.Services.GetRequiredService<Teren.Infrastructure.Logging.AppLogWriter>()
            .FlushAsync(ct);

    private static TerenIdentityDbContext CreateIdentityDbContext(string connectionString)
    {
        var options = new DbContextOptionsBuilder<TerenIdentityDbContext>()
            .UseNpgsql(connectionString, npgsql => npgsql
                .MigrationsHistoryTable(TerenIdentityDbContext.MigrationsHistoryTable))
            .Options;

        return new TerenIdentityDbContext(options);
    }

    /// <summary>
    /// Run the invite job by hand and hand back the message it produced, or null if it sent none.
    ///
    /// <para>
    /// <b>Called directly rather than through the queue, and that is the point.</b> The test host
    /// runs with <c>Hangfire__Enabled=false</c>, so the route only ever reaches
    /// <c>DisabledInviteQueue</c> and nothing is sent — which is itself asserted, in
    /// <c>PlatformSurfaceTests</c>. What the *job* does is a separate question with separate
    /// tests, and this is the seam that lets them ask it: a real identity context, a real token
    /// mint, a real body, and a sender that keeps what it was handed instead of dialling a relay.
    /// </para>
    /// <para>
    /// <paramref name="appUrl"/> defaults to a real-looking origin because a missing one is a
    /// *tested* branch: with no <c>Auth:AppUrl</c> there is no address to send anyone to, and the
    /// job refuses to post a bare token nobody can use.
    /// </para>
    /// </summary>
    /// <param name="passwordTokenLifetime">
    /// <c>Auth:PasswordTokenLifetime</c>. Overridable because the job hardcoded 48 hours until
    /// 2026-09-02 while already injecting the options object that carries it — so a host that
    /// shortened the setting got links that outlived it, and the mail printed the literal.
    /// </param>
    /// <param name="notice">
    /// What the company's other administrators are to be told once the link has gone out. It rides
    /// on the invite rather than being announced at the request, because only this job knows
    /// whether anything was actually sent — see <see cref="AdminInviteJob"/>.
    /// </param>
    /// <param name="notices">
    /// Where the job asks for that notice. Defaults to <see cref="Invites"/>, the same recorder the
    /// host uses, so a test can assert the ask without wiring anything.
    /// </param>
    public async Task<Core.Mail.MailMessage?> RunInviteJobAsync(
        Guid userId,
        Guid actorUserId,
        CancellationToken ct,
        IMailSender? sender = null,
        string appUrl = "https://app.teren.test",
        TimeSpan? passwordTokenLifetime = null,
        AdminAccessNotice notice = AdminAccessNotice.CredentialIssued,
        IInviteQueue? notices = null)
    {
        var mail = sender ?? new CapturingMailSender();

        await using var identity = CreateIdentityDbContext();

        var options = new AuthOptions { AppUrl = appUrl };
        if (passwordTokenLifetime is { } lifetime)
        {
            options.PasswordTokenLifetime = lifetime;
        }

        var job = new AdminInviteJob(
            identity,
            mail,
            notices ?? Invites,
            Options.Create(options),
            NullLogger<AdminInviteJob>.Instance);

        await job.RunAsync(userId, actorUserId, notice, ct);

        return (mail as CapturingMailSender)?.Last;
    }

    /// <summary>
    /// Run the worker's activation-code mail job by hand and hand back the message it produced, or
    /// null if it sent none.
    ///
    /// <para>
    /// <b>The job is where the code is minted</b>, which is the whole point of the increment:
    /// <c>POST /auth/activation-code</c> used to supersede a foreman's live code inside the
    /// request and then send nothing, so anybody who could guess a username could invalidate it.
    /// Every reason not to send is checked here before a row is written — which is why the
    /// interesting assertions are about what did <em>not</em> change.
    /// </para>
    /// <para>
    /// Driven directly for the same reason <see cref="RunInviteJobAsync"/> is: the test host runs
    /// with <c>Hangfire__Enabled=false</c>, so the route reaches <c>DisabledInviteQueue</c> and
    /// nothing runs — which is itself asserted.
    /// </para>
    /// </summary>
    public async Task<Core.Mail.MailMessage?> RunWorkerCodeJobAsync(
        Guid userId,
        CancellationToken ct,
        IMailSender? sender = null,
        string appUrl = "https://app.teren.test")
    {
        var mail = sender ?? new CapturingMailSender();

        await using var identity = CreateIdentityDbContext();

        var job = new WorkerCodeMailJob(
            identity,
            mail,
            Options.Create(new AuthOptions { AppUrl = appUrl }),
            NullLogger<WorkerCodeMailJob>.Instance);

        await job.RunAsync(userId, ct);

        return (mail as CapturingMailSender)?.Last;
    }

    /// <summary>
    /// Run the access-notice job by hand and hand back <b>every</b> message it produced — a list
    /// rather than a slot, because the whole point of the job is that it writes to more than one
    /// person (<see cref="AdminAccessNoticeJob"/>, plan §13.6).
    ///
    /// <para>
    /// Driven directly for the same reason <see cref="RunInviteJobAsync"/> is: the test host runs
    /// with <c>Hangfire__Enabled=false</c>, so a route reaches <c>DisabledInviteQueue</c> and
    /// nothing runs. That the routes <em>ask</em> for this job is a separate question, asked
    /// against a recording queue in <c>AdminAccessNoticeTests</c>.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<Core.Mail.MailMessage>> RunAccessNoticeJobAsync(
        Guid subjectUserId,
        AdminAccessNotice notice,
        DateTime occurredAt,
        CancellationToken ct,
        IMailSender? sender = null)
    {
        var mail = sender ?? new CapturingMailSender();

        await using var identity = CreateIdentityDbContext();

        var job = new AdminAccessNoticeJob(
            identity, mail, NullLogger<AdminAccessNoticeJob>.Instance);

        await job.RunAsync(subjectUserId, notice, occurredAt, ct);

        return (mail as CapturingMailSender)?.Sent ?? [];
    }

    /// <summary>
    /// A database migrated only as far as the last pre-D1 migration — i.e. exactly what a founder
    /// laptop or a staging box looks like the moment before this increment is deployed. There is
    /// no identity schema on it at all, which is the state that made `reset-demo` die on a bare
    /// Npgsql 42P01.
    /// </summary>
    public async Task<string> CreatePreIdentityDatabaseAsync()
    {
        var name = "teren_pre_identity_" + Interlocked.Increment(ref _scratchDatabaseCounter);
        await ExecuteOnMaintenanceDatabaseAsync("CREATE DATABASE " + name);

        var connectionString = ConnectionStringFor(name);

        await using var db = CreateDbContext(connectionString);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync(LastPreIdentityMigration);

        return connectionString;
    }

    /// <summary>The migration D1 was built on top of. Named rather than computed, so that adding a
    /// migration later cannot quietly move what "before D1" means.</summary>
    public const string LastPreIdentityMigration = "20260829201636_ProjectTimeZoneAndReportChecksum";

    /// <summary>
    /// A database with the evidence schema fully applied and <b>no identity history at all</b> —
    /// the exact half-migrated host the D1 review found <c>reset-demo</c> dying on, and the state a
    /// readiness check that looked at one context would call ready.
    /// </summary>
    public async Task<string> CreateEvidenceOnlyDatabaseAsync()
    {
        var name = "teren_evidence_only_" + Interlocked.Increment(ref _scratchDatabaseCounter);
        await ExecuteOnMaintenanceDatabaseAsync("CREATE DATABASE " + name);

        var connectionString = ConnectionStringFor(name);

        await using var db = CreateDbContext(connectionString);
        await db.Database.MigrateAsync();

        return connectionString;
    }

    /// <summary>
    /// A brand-new database with the schema and nothing in it, cloned from the migrated template.
    /// The seeder tests need a database no other test has touched — that is the only way "a
    /// database at an older seed state gains exactly the missing rows" means anything.
    /// </summary>
    public async Task<TerenDbContext> CreateScratchDatabaseAsync(
        Guid? companyId = null,
        params Microsoft.EntityFrameworkCore.Diagnostics.IInterceptor[] interceptors)
    {
        var name = "teren_scratch_" + Interlocked.Increment(ref _scratchDatabaseCounter);
        await ExecuteOnMaintenanceDatabaseAsync(
            "CREATE DATABASE " + name + " TEMPLATE " + TemplateDatabase);
        return CreateDbContext(ConnectionStringFor(name), companyId, interceptors);
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
        Delivery.Reset();
        Mail.Reset();
        Renderer.Reset();
        RaceInterceptor.Disarm();
        CommandTap.Reset();
        Queue.Depth = JobQueueDepth.Unknown(JobQueueDepth.NotConfigured);
        Invites.Reset();

        // D5. The log queue is drained BEFORE the truncate below, and the order is the whole
        // point: every test in this run emits log lines, and a flush that arrived after the
        // truncate would put the previous test's warnings in the table this one is asserting
        // about. Discarded rather than written — nothing in the suite wants the last test's log.
        LogQueue.Discard();

        await using var db = CreateDbContext(companyId: null);
        // Every table any test can write to, identity included. This list, DemoReset's ordered
        // delete and DemoRowCounts grow together or the reset's safety assertion gains a blind
        // spot (profile-and-identity §13.3).
        await db.Database.ExecuteSqlRawAsync(
            """
            TRUNCATE TABLE
                media, report, entry, project,
                admin_audit, admin_session, password_token, activation_code, device, app_user,
                app_log, company
            RESTART IDENTITY CASCADE
            """);

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
                // One recipient, Serbian: the ordinary private job.
                Recipients = OneRecipient,
                ReportLanguage = "sr",
                CreatedAt = now,
            },
            new Project
            {
                Id = TestIds.ProjectA2,
                CompanyId = TestIds.CompanyA,
                Name = "Zgrada B",
                // Two recipients, and English. Both halves are load-bearing: commercial jobs in
                // Serbia carry the investor and the nadzorni organ on one list (which is why the
                // demo seed's second site does too), and a foreign investor's project is what
                // proves the report follows project.report_language rather than the caller.
                Recipients = TwoRecipients,
                ReportLanguage = "en",
                CreatedAt = now,
            },
            new Project
            {
                Id = TestIds.ProjectB1,
                CompanyId = TestIds.CompanyB,
                Name = "Gradiliste druge firme",
                Recipients = OneRecipient,
                ReportLanguage = "sr",
                CreatedAt = now,
            });

        await db.SaveChangesAsync();

        // The caller behind every authenticated test: a real worker and a real phone, exactly as
        // production has them. This is what replaced Auth__CompanyId / Auth__DeviceId — the
        // stamping assertions did not change, but they now prove the device table stamps an
        // entry rather than a configuration value.
        await using var identity = CreateIdentityDbContext();

        identity.Users.Add(new AppUser
        {
            Id = TestIds.WorkerA,
            CompanyId = TestIds.CompanyA,
            Role = AppUserRole.Worker,
            Username = TestIds.WorkerAUsername,
            DisplayName = "Zoran Jovanović",
            Language = "sr",
            CreatedAt = now,
        });

        identity.Devices.Add(new Device
        {
            Id = TestIds.DeviceA,
            CompanyId = TestIds.CompanyA,
            UserId = TestIds.WorkerA,
            Name = "Zoranov telefon",
            TokenHash = CredentialTokens.Hash(DeviceToken),
            CreatedAt = now,
        });

        await identity.SaveChangesAsync();
    }

    /// <summary>The distribution lists the baseline projects carry, in the shape ARCHITECTURE §6
    /// fixes for <c>project.recipients</c>.</summary>
    public const string OneRecipient =
        """
        [{"name": "Dragan Obradović", "email": "dragan.obradovic@example.com", "role": "investitor"}]
        """;

    public const string TwoRecipients =
        """
        [{"name": "Jelena Marković", "email": "jelena.markovic@example.com", "role": "investitor"},
         {"name": "Aleksandar Stanković", "email": "aleksandar.stankovic@example.com", "role": "nadzorni organ"}]
        """;

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

                // The health page's queue depth. Hangfire is off in this host, so the container's
                // own registration is the "not configured" one; substituting it is what makes the
                // numeric half of /api/platform/health assertable.
                services.RemoveAll<IJobQueueDepth>();
                services.AddSingleton<IJobQueueDepth>(app.Queue);

                // The mail-job queue. Recorded rather than faked out: the shipped registration on
                // this host is DisabledInviteQueue, which answers exactly as this does by default
                // and remembers nothing — see RecordingInviteQueue for what that cost.
                services.RemoveAll<IInviteQueue>();
                services.AddSingleton<IInviteQueue>(app.Invites);

                // The mail relay, faked at the seam PROJECT.md §11 put there. The renderer is
                // *not* faked — it is the real one, wrapped so the model it was handed can be
                // inspected.
                services.RemoveAll<IReportDelivery>();
                services.AddSingleton<IReportDelivery>(app.Delivery);

                services.RemoveAll<IReportRenderer>();
                services.AddSingleton<IReportRenderer>(app.Renderer);

                // Transactional mail. Every job that sends one is driven directly by this
                // fixture, so what the container copy is for is the ROUTES that branch on
                // IsConfigured — see the Mail property.
                services.RemoveAll<IMailSender>();
                services.AddSingleton<IMailSender>(app.Mail);

                // A second AddDbContext contributes another options configuration, applied after
                // the one in Program.cs; the connection string is identical (both come from the
                // environment variable), and this one carries the interceptor that makes the
                // insert race deterministic.
                services.AddDbContext<TerenDbContext>(options => options
                    .UseNpgsql(app.ApiConnectionString)
                    .AddInterceptors(app.RaceInterceptor, app.CommandTap));

                // The identity context gets the same interceptor, because the race that matters
                // most now lives there: two phones typing one activation code. Without this,
                // ActivationRaceTests would be two parallel requests and a hope.
                services.AddDbContext<TerenIdentityDbContext>(options => options
                    .UseNpgsql(app.ApiConnectionString, npgsql => npgsql
                        .MigrationsHistoryTable(TerenIdentityDbContext.MigrationsHistoryTable))
                    .AddInterceptors(app.RaceInterceptor, app.CommandTap));
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
