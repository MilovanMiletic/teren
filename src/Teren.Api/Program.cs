using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;
using System.Threading.RateLimiting;
using FluentValidation;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Hangfire;
using Microsoft.Extensions.Options;
using Serilog;
using Teren.Api.Hangfire;
using Teren.Core.Mail;
using Teren.Core.Ai;
using Teren.Core.Reporting;
using Teren.Infrastructure.Processing;
using Teren.Infrastructure.Reporting;
using Teren.Api.Contracts;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Auth;
using Teren.Api.Health;
using Teren.Api.Platform;
using Teren.Api.Endpoints;
using Teren.Api.Jobs;
using Teren.Api.Maintenance;
using Teren.Api.Errors;
using Teren.Api.Validation;
using Teren.Core.Storage;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Logging;
using Teren.Infrastructure.Mail;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Seeding;
using Teren.Infrastructure.Storage;
using Teren.Infrastructure.Tenancy;

var builder = WebApplication.CreateBuilder(args);

// D5. Serilog's own failure channel, before anything can fail. Every way the app_log sink can
// break reports here and nowhere else — an ILogger call from inside the log writer would enqueue a
// row about failing to write rows — and SelfLog is disabled by default, which made all of them
// silent. A host started without `migrate` is this repo's most repeated failure, and it drops
// every batch on a 42P01 while the log viewer simply looks empty. See SelfLogChannel.
SelfLogChannel.EnableToStandardError();

// Structured logging to stdout (ARCHITECTURE §13). The pipeline pushes the entry id into a log
// scope, so every line about one entry carries it — which is the difference between reading a
// job failure and guessing at one. Nothing personal is ever logged: ids, not names or addresses.
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .WriteTo.Console(
        outputTemplate:
        "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}")
    // D5: the same events, scrubbed, into `app_log` for the super admin's viewer. Resolved from
    // the container rather than constructed here so the queue it writes into is the same
    // singleton POST /api/client-events enqueues to — two copies of that buffer would mean the
    // flusher drained one of them and the other grew until the process died of it.
    .WriteTo.Sink(services.GetRequiredService<PostgresLogSink>()));

builder.Services.AddOpenApi();
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<MalformedRequestExceptionHandler>();
builder.Services.AddExceptionHandler<StorageUnavailableExceptionHandler>();

// snake_case on the wire, matching the column names in ARCHITECTURE §6 and the field names in
// §7-§8. One vocabulary across the database, the API and the docs; nothing to translate when
// reading a log line next to a psql row.
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;

    // Serbian is the content, not an exception: emit č/ć/š/ž/đ as themselves instead of \u
    // escapes, so payloads and log lines stay readable and stay small. HTML-sensitive
    // characters are still escaped — this is not UnsafeRelaxedJsonEscaping.
    options.SerializerOptions.Encoder = JavaScriptEncoder.Create(UnicodeRanges.All);
});

// Validation messages name fields the way the client spelled them.
ValidatorOptions.Global.PropertyNameResolver =
    (_, member, _) => member is null
        ? null
        : JsonNamingPolicy.SnakeCaseLower.ConvertName(member.Name);

// Scoped tenant context: BearerAuthFilter sets CompanyId from the caller's token before any
// handler runs. Query filters are deny-by-default, so an unset tenant returns no rows rather
// than everyone's rows.
builder.Services.AddScoped<TenantContext>();

var connectionString = builder.Configuration.GetConnectionString("Postgres")
    ?? throw new InvalidOperationException(
        "Connection string 'Postgres' is not configured. Locally it lives in " +
        "appsettings.Development.json; in production set ConnectionStrings__Postgres.");

builder.Services.AddDbContext<TerenDbContext>(options => options.UseNpgsql(connectionString));

// The platform-side model (profile-and-identity §6, layer 3): app_user, device, activation_code
// and friends, plus company read-only. It carries no query filters, which is what lets the
// credential authenticator resolve a token before any tenant is known without reaching for
// IgnoreQueryFilters. Its migrations live in their own history table so both models stay
// scaffoldable and neither can drift from its schema.
builder.Services.AddDbContext<TerenIdentityDbContext>(options => options
    .UseNpgsql(connectionString, npgsql => npgsql
        .MigrationsHistoryTable(TerenIdentityDbContext.MigrationsHistoryTable)));

// D5: the log stream — a bounded queue, a background flusher, the scrubbing sink and the nightly
// retention job. Registered BEFORE the logger is built above resolves PostgresLogSink out of it.
//
// Verbose and Debug reach `app_log` only in Development. The console keeps them everywhere; this
// table does not, because it is a firehose on a small VPS and debug rows are the difference
// between a fortnight of retained log and the largest thing in the nightly backup.
builder.Services.AddTerenLogging(
    builder.Configuration, connectionString, storeDebugLevels: builder.Environment.IsDevelopment());

// Object storage: presigned PUT URLs out, HEAD verification back. Local values come from
// appsettings.Development.json (throwaway MinIO credentials); production sets Storage__* env vars.
builder.Services
    .AddOptions<StorageOptions>()
    .Bind(builder.Configuration.GetSection(StorageOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddSingleton<IObjectStorage, S3ObjectStorage>();

// Auth: the bearer token a phone presents is hashed and looked up in the device table
// (profile-and-identity §7). Auth:DeviceToken is no longer the authentication system — it is one
// device's token, provisioned as a real row by DemoSeeder — so it is no longer required, and an
// empty value means "no demo device" rather than "an API that accepts anonymous writes". The
// gate itself is unconditional: no valid bearer token, no request, regardless of configuration.
builder.Services
    .AddOptions<DeviceAuthOptions>()
    .Bind(builder.Configuration.GetSection(DeviceAuthOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddScoped<ICredentialAuthenticator, DbCredentialAuthenticator>();
builder.Services.AddScoped<PlatformDirectory>();

// Ordinary transactional mail — invites, and whatever follows. Deliberately a separate seam from
// IReportDelivery, whose custody semantics exist to stop a client getting two copies of his diary
// and mean nothing for an invite (see SmtpMailSender for why the two are not merged).
builder.Services.AddSingleton<IMailSender, SmtpMailSender>();
builder.Services.AddScoped<AdminInviteJob>();

// D6's worker half: mails one man his own activation code, and — the point of it being a job —
// mints that code inside itself, so an unauthenticated request that cannot mail supersedes
// nothing. See WorkerCodeMailJob.
builder.Services.AddScoped<WorkerCodeMailJob>();

// §13.6's answer: whenever a set-password link for a company admin actually goes out, this tells
// that company's OTHER administrators that it happened. Registered here because Hangfire activates
// a job out of the container — and every test in the suite constructs these jobs by hand, so a
// missing registration is invisible to a green suite and shows up only as a failed job on the
// founder's host.
builder.Services.AddScoped<AdminAccessNoticeJob>();

// Session lifetimes, credential TTLs and the rate-limit window. Bound from the same Auth section;
// every value in it is a security parameter and every one is pinned by a test.
builder.Services
    .AddOptions<AuthOptions>()
    .Bind(builder.Configuration.GetSection(AuthOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

// The fixed window in front of /auth/* (profile-and-identity §7). Ten attempts per five minutes
// per client IP, 429 with Retry-After. AddRateLimiter ships in the shared framework — no package.
//
// By IP and NOT by account, deliberately: a per-account lockout hands an attacker a way to lock a
// paying customer out of his own reports with nothing but an email address.
var authRateLimit = builder.Configuration
    .GetSection(AuthOptions.SectionName)
    .Get<AuthOptions>()?.RateLimit ?? new AuthRateLimitOptions();

builder.Services.AddRateLimiter(limiter =>
{
    limiter.AddPolicy(AuthRateLimitPolicy.Name, http => RateLimitPartition.GetFixedWindowLimiter(
        // RemoteIpAddress is trustworthy because Hosting:BehindProxy wires UseForwardedHeaders on
        // the hosts that sit behind Caddy — and the API port is not published there, so nothing
        // but the proxy can set the header. A null address (nothing has one in a unit-test host)
        // collapses to one shared partition, which is the safe direction: stricter, not looser.
        partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = authRateLimit.PermitLimit,
            Window = authRateLimit.Window,
            // No queue. A credential attempt that waits its turn is a request holding a thread on
            // a small VPS; the honest answer is "not now, try again in N seconds".
            QueueLimit = 0,
        }));

    // D5's ingress, bounded per caller (Logging:ClientEvents:RateLimitPerMinute, 60). The body
    // cap on that route bounds one request; nothing bounded a client, and the queue it feeds
    // drops the OLDEST row when full — so one phone in a retry loop could push every server-side
    // line out of the table Teren staff read to find out what is wrong. See
    // ClientEventRateLimitPolicy for why the partition is the credential's hash and not the
    // principal (this is middleware; the auth filter has not run yet).
    var clientEventLimit = builder.Configuration
        .GetSection(LoggingOptions.SectionName)
        .Get<LoggingOptions>()?.ClientEvents.RateLimitPerMinute
        ?? new ClientEventOptions().RateLimitPerMinute;

    limiter.AddPolicy(
        ClientEventRateLimitPolicy.Name,
        http => RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ClientEventRateLimitPolicy.PartitionKey(http),
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = clientEventLimit,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));

    // The only other public, unauthenticated route with a cost. See ReadinessRateLimitPolicy for
    // why the number is what it is and why it is a constant rather than a setting; /health stays
    // unlimited because it is a constant and refusing a liveness probe restarts a healthy process.
    limiter.AddPolicy(
        ReadinessRateLimitPolicy.Name,
        http => RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = ReadinessRateLimitPolicy.PermitLimit,
                Window = ReadinessRateLimitPolicy.Window,
                QueueLimit = 0,
            }));

    limiter.OnRejected = async (context, ct) =>
    {
        var retryAfter = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var window)
            ? window
            : authRateLimit.Window;

        context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);

        // Problem details like every other refusal in this API, so a client has one shape to
        // parse. Says nothing about which account or which credential was being tried.
        await context.HttpContext.Response.WriteAsJsonAsync(
            new ProblemDetails
            {
                Title = "Too many requests",
                Detail = "Too many attempts from this address. Wait a moment and try again.",
                Status = StatusCodes.Status429TooManyRequests,
            },
            ct);
    };
});

// B4: transcription, extraction, the processor and the sweeper.
builder.Services.AddTerenPipeline(builder.Configuration);

// Hangfire in the same process as the API (ARCHITECTURE §4). Switchable off so the upload path
// — which needs no job server at all — stays runnable and testable without one.
builder.Services.AddTerenJobs(builder.Configuration, connectionString);

// The two destructive seams exist in the container ONLY for `reset-demo`. Nothing that serves a
// request — no endpoint, no job, no accident — can inject a way to erase an object or cancel a
// job, because outside this one command neither interface is registered at all. Widening
// IObjectStorage instead would have handed a destructive verb to every service on the request
// path in exchange for nothing. See DemoReset.
if (args.Contains(DemoResetGuard.CommandName))
{
    builder.Services.AddSingleton<IDemoObjectPurge, S3DemoObjectPurge>();

    if (builder.Configuration.GetValue("Hangfire:Enabled", defaultValue: true))
    {
        builder.Services.AddSingleton<IDemoJobPurge, HangfireDemoJobPurge>();
    }
    else
    {
        builder.Services.AddSingleton<IDemoJobPurge, NoDemoJobPurge>();
    }
}

// Readiness (see Health/ReadinessChecks.cs). /health stays the constant it always was — liveness
// — and this is the route a deploy and a container healthcheck ask, because the failure this
// project actually keeps having is a host that boots, answers `ok`, and cannot serve a request:
// an un-migrated schema. The job-server check is registered only where a job server is expected.
var readiness = builder.Services.AddHealthChecks()
    .AddCheck<DatabaseReadyCheck>(ReadinessChecks.Database)
    .AddCheck<MigrationsReadyCheck>(ReadinessChecks.Migrations);

if (builder.Configuration.GetValue("Hangfire:Enabled", defaultValue: true))
{
    readiness.AddCheck<JobServerReadyCheck>(ReadinessChecks.JobServer);
}

builder.Services.AddSingleton<IValidator<CreateEntryRequest>, CreateEntryRequestValidator>();
builder.Services.AddSingleton<IValidator<DeclareMediaRequest>, DeclareMediaRequestValidator>();
builder.Services.AddSingleton<IValidator<ConfirmEntryRequest>, ConfirmEntryRequestValidator>();
builder.Services.AddSingleton<IValidator<ActivateRequest>, ActivateRequestValidator>();
builder.Services.AddSingleton<IValidator<ActivationCodeRequestBody>, ActivationCodeRequestBodyValidator>();
builder.Services.AddSingleton<IValidator<LoginRequest>, LoginRequestValidator>();
builder.Services.AddSingleton<IValidator<SetPasswordRequest>, SetPasswordRequestValidator>();
builder.Services.AddSingleton<IValidator<CreateWorkerRequest>, CreateWorkerRequestValidator>();
builder.Services.AddSingleton<IValidator<UpdateWorkerRequest>, UpdateWorkerRequestValidator>();
builder.Services.AddSingleton<IValidator<CreateCompanyRequest>, CreateCompanyRequestValidator>();
builder.Services.AddSingleton<IValidator<CreateAdminRequest>, CreateAdminRequestValidator>();
builder.Services.AddSingleton<IValidator<ClientEventBatchRequest>, ClientEventBatchRequestValidator>();

// Staging and production put Caddy in front of this process (ARCHITECTURE §13): Caddy owns the
// certificate and forwards over the private compose network in plain HTTP. Without this, two
// things break in ways that look like something else.
//
//   * `Request.Scheme` would read "http" on every request, so `UseHttpsRedirection` below would
//     answer *every* call — the container healthcheck included — with a 307 to an https URL on
//     the API's own internal port, which nothing listens on. The stack would look broken at the
//     proxy rather than here.
//   * `RemoteIpAddress` would be the proxy's container address, so every log line and the
//     Hangfire dashboard's loopback check would see one single client.
//
// KnownNetworks/KnownProxies are cleared deliberately, and that is only safe because of how the
// stack is deployed: the API port is **not published to the host** in
// `deploy/docker-compose.prod.yml`, so the only thing that can reach this process is the proxy
// on the internal network. Publish that port and this becomes a header-spoofing hole.
//
// Off by default — a developer running `dotnet run` is not behind anything.
var behindProxy = builder.Configuration.GetValue("Hosting:BehindProxy", defaultValue: false);

if (behindProxy)
{
    builder.Services.Configure<ForwardedHeadersOptions>(options =>
    {
        // Proto and For only. X-Forwarded-Host is deliberately not honoured: nothing here
        // derives a URL from the request host (presigned URLs come from Storage:PublicEndpoint),
        // so trusting it would add spoofing surface in exchange for nothing.
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
        // KnownIPNetworks, not the obsolete KnownNetworks (ASPDEPR005).
        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();
    });
}

var corsOrigins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins(corsOrigins).AllowAnyHeader().AllowAnyMethod()
            // Content-Disposition is **not** on the CORS-safelist, so a browser hides it from
            // JavaScript unless it is named here. Without this line the report download
            // (GET /api/entries/{id}/report) still works, but the app cannot read the file name
            // the API went to some trouble to build — the site and the date, folded to ASCII —
            // and every saved report lands under a generic fallback instead.
            //
            // It is not a theoretical cross-origin case: in development the PWA is served from
            // localhost:4200 and the API from localhost:5080, which are different origins, and in
            // production the app and the API need not share one either.
            //
            // Content-Length is already safelisted and needs no entry; Content-Type likewise.
            .WithExposedHeaders("Content-Disposition")));

var app = builder.Build();

// One-shot maintenance commands:
//   dotnet run --project src/Teren.Api -- migrate      apply pending EF migrations
//   dotnet run --project src/Teren.Api -- seed         migrate + seed the demo data (idempotent)
//   dotnet run --project src/Teren.Api -- reset-demo   DESTRUCTIVE: see DemoResetGuard
//   dotnet run --project src/Teren.Api -- create-super-admin --email … --name …
//   dotnet run --project src/Teren.Api -- invite-admin --email …
//
// None of these reach app.Run(), so no hosted service starts: `reset-demo` does not bring up a
// Hangfire worker that would start executing the jobs it is about to delete.
if (args.Contains(DemoResetGuard.CommandName))
{
    Environment.ExitCode = await DemoResetCommand.RunAsync(app, args);
    return;
}

if (args.Contains(CreateSuperAdminCommand.CommandName))
{
    using var scope = app.Services.CreateScope();
    var identityDb = scope.ServiceProvider.GetRequiredService<TerenIdentityDbContext>();

    // Migrations first, for the same reason `reset-demo` learned to: on a box that has not been
    // migrated this would otherwise die on a bare Npgsql 42P01, and this is the command a founder
    // runs on a brand-new host before anything else exists.
    //
    // BOTH histories, and the evidence one first. The identity migration creates app_user, device
    // and activation_code with foreign keys to `company`, whose DDL TerenDbContext owns — so on a
    // genuinely fresh database, migrating identity alone fails on a bare 42P01 for `company`.
    // That is the same class of failure the D1 review found in `reset-demo`, and this command was
    // carrying it too.
    await scope.ServiceProvider.GetRequiredService<TerenDbContext>().Database.MigrateAsync();
    await identityDb.Database.MigrateAsync();

    Environment.ExitCode = await CreateSuperAdminCommand.RunAsync(
        identityDb,
        args,
        Console.In,
        Console.Out,
        // Masked, non-echoing input when there is a terminal; one piped line when there is not.
        maskInput: !Console.IsInputRedirected);

    return;
}

// The other half of the bootstrap: `create-super-admin` sets a password at the console, this one
// mints a link for somebody who is not standing at it. Nothing else in the product ever creates a
// password_token, so without it an invited company admin can never sign in — and therefore no
// activation code can be issued through the product at all. See InviteAdminCommand.
if (args.Contains(InviteAdminCommand.CommandName))
{
    using var scope = app.Services.CreateScope();
    var identityDb = scope.ServiceProvider.GetRequiredService<TerenIdentityDbContext>();

    await scope.ServiceProvider.GetRequiredService<TerenDbContext>().Database.MigrateAsync();
    await identityDb.Database.MigrateAsync();

    // The TTL comes from Auth:PasswordTokenLifetime — the same validated option /auth/password
    // is measured against — rather than a literal here, so there is one answer to "how long is a
    // link good for" and a test pins it.
    var authOptions = scope.ServiceProvider.GetRequiredService<IOptions<AuthOptions>>().Value;

    Environment.ExitCode = await InviteAdminCommand.RunAsync(
        identityDb,
        args,
        Console.Out,
        authOptions.PasswordTokenLifetime,
        authOptions.AppUrl);

    return;
}

if (args.Contains("migrate") || args.Contains("seed"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<TerenDbContext>();
    var identityDb = scope.ServiceProvider.GetRequiredService<TerenIdentityDbContext>();

    // Two models, two migration histories, and this order is not arbitrary: device.company_id
    // and app_user.company_id reference the company table, which the evidence model owns.
    await db.Database.MigrateAsync();
    await identityDb.Database.MigrateAsync();
    Console.WriteLine("Migrations applied (schema + identity).");

    if (args.Contains("seed"))
    {
        // The demo device's token. Empty means "provision no device", which is the D7 end state
        // and is a working seed, not a failure.
        var deviceToken = scope.ServiceProvider
            .GetRequiredService<IOptions<DeviceAuthOptions>>().Value.DeviceToken;

        // The fixed, repo-published demo code is minted **only on a development host**. It is a
        // real credential to the demo company that anyone who can read the repository already
        // holds; on a laptop that costs nothing, and behind a public URL it is a way in.
        var publishDemoCode = app.Environment.IsDevelopment();

        var inserted = await DemoSeeder.SeedAsync(db, deviceToken, publishDemoCode);
        Console.WriteLine(inserted == 0
            ? "Demo data already present and usable; nothing written."
            : $"Demo data seeded: {inserted} row(s) written.");

        // Printed on every seed, not only when a row was written: this is the one credential a
        // fresh phone needs to get past the welcome screen, and there is no admin screen to read
        // it from until F6.
        Console.WriteLine(publishDemoCode
            ? $"Demo activation: username {DemoSeeder.WorkerUsername}, "
              + $"code {DemoSeeder.DemoActivationCodeDisplay}."
            : $"Demo activation: username {DemoSeeder.WorkerUsername}, and NO code — the "
              + "published one is minted on development hosts only. Issue him a real code from "
              + "/company.");
    }

    return;
}

// Before anything that reads the scheme or the client address, which is everything below.
if (behindProxy)
{
    app.UseForwardedHeaders();
}

app.UseExceptionHandler();
app.UseStatusCodePages();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
else if (!behindProxy)
{
    // Caddy already redirects http to https at the edge, and the hop from Caddy to this process
    // is plain HTTP on a private network by design. Redirecting here would only bounce the
    // proxy's own request — and the healthcheck — to a port nothing is listening on.
    app.UseHttpsRedirection();
}

app.UseCors();

// Before the endpoints it guards, and after UseForwardedHeaders so the partition key is the real
// client address rather than the proxy's.
app.UseRateLimiter();

// Liveness: the process is up and answering. A constant on purpose — a liveness probe that goes
// red because a database blinked is a probe that restarts a healthy process.
app.MapGet("/health", () => Results.Ok(new HealthResponse("ok", "teren-api")));

// Readiness: can this host actually serve a request. Both migration histories, both contexts, and
// the job server where one is expected. `deploy.sh` and the container healthcheck ask this one.
//
// Rate-limited, unlike /health, because this one costs four database round trips and a Hangfire
// storage read per hit and is answered to anybody. The window is wide enough that no probe this
// repository ships can reach it (ReadinessRateLimitPolicy).
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    ResponseWriter = ReadinessEndpoint.WriteAsync,
}).RequireRateLimiting(ReadinessRateLimitPolicy.Name);

// The public door: activation, login, set-password. DELIBERATELY NOT under /api, so that
// TenancyTests.Every_api_route_sits_behind_the_token stays literally true rather than
// "true with exceptions" — an exception list on that test is how it stops being worth running.
app.MapGroup("/auth")
    .RequireRateLimiting(AuthRateLimitPolicy.Name)
    .WithTags("Auth")
    .MapAuthEndpoints();

// Everything under /api is behind the bearer token, which also resolves the tenant. Adding a
// route to this group is all it takes to be tenant-scoped and authenticated.
//
// FILTER ORDER MATTERS AND IS ESTABLISHED HERE: group filters run outside route filters, so this
// one runs first, each sub-group's RoleFilter runs next, and a route's ValidationFilter<T> runs
// last. That is what makes 401 beat 403 beat 400 — an anonymous caller learns nothing about which
// roles a route admits, and a caller of the wrong role learns nothing about its payload shape.
var api = app.MapGroup("/api").AddEndpointFilter<BearerAuthFilter>();

api.MapMeEndpoints();
api.MapProjectEndpoints();
api.MapEntryEndpoints();
api.MapWorkerEndpoints();
api.MapDeviceEndpoints();
api.MapPlatformEndpoints();
api.MapClientEventEndpoints();

// Said once, loudly, rather than discovered as a 401 on a demo phone. An empty Auth:DeviceToken
// is a legitimate configuration — it is the D7 end state — but on a box that is meant to be
// demoable it means the seeded device does not exist and the bundled PWA token authenticates
// nothing. Standing policy: visible failure, startup warning, never a boot refusal.
if (!app.Services.GetRequiredService<IOptions<DeviceAuthOptions>>().Value.HasDeviceToken)
{
    app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Teren.Auth").LogWarning(
        "Auth:DeviceToken is empty: no demo device is provisioned, so every device bearer token "
        + "will be rejected until a device is activated. Set Auth__DeviceToken and re-run `seed` "
        + "if this host is meant to run the demo.");
}

if (builder.Configuration.GetValue("Hangfire:Enabled", defaultValue: true))
{
    var jobsLogger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Teren.Jobs");

    app.MapHangfireDashboard("/hangfire", new DashboardOptions
    {
        Authorization =
        [
            new HangfireDashboardAuthorization(
                builder.Configuration["Hangfire:DashboardUser"],
                builder.Configuration["Hangfire:DashboardPassword"],
                jobsLogger),
        ],
    });

    // The safety net under the enqueue path: anything `/complete` failed to queue, and anything
    // abandoned mid-pass by a restart, is found here rather than sitting invisible.
    var pipelineOptions = app.Services.GetRequiredService<IOptions<PipelineOptions>>().Value;

    // Pipeline:SweepInterval, rendered as cron. The same string is logged below, so the option,
    // the schedule and the log line cannot drift apart the way they did when this was a
    // hardcoded Cron.Minutely with a log that quoted the (ignored) configured interval.
    var sweepCron = pipelineOptions.SweepCronExpression();

    app.Services.GetRequiredService<IRecurringJobManager>().AddOrUpdate<PipelineSweepJob>(
        PipelineSweepJob.RecurringJobId,
        job => job.RunAsync(null!),
        sweepCron);

    // D5. Without this the log table is the only thing in the database that grows for ever, and
    // the first anyone hears of it is a backup that no longer fits or a restore that no longer
    // finishes. Daily, in the small hours, and idempotent — a missed run costs a day of extra
    // rows and nothing else.
    app.Services.GetRequiredService<IRecurringJobManager>().AddOrUpdate<LogRetentionJob>(
        LogRetentionJob.RecurringJobId,
        job => job.RunAsync(null!),
        LogRetentionJob.Schedule);

    // Said once, loudly, at start-up rather than discovered per entry in a job log. A missing
    // key is a working host that will park entries in needs_review — which is the honest
    // behaviour, but not something anyone should first learn from a foreman.
    var transcription = app.Services.GetRequiredService<ITranscriptionProvider>();
    var extractor = app.Services.GetRequiredService<IStructureExtractor>();

    if (!transcription.IsConfigured)
    {
        jobsLogger.LogWarning(
            "Transcription ({Provider}) has no key configured: entries with audio will park in "
            + "needs_review. Set Stt:Azure:Key and Stt:Azure:Region.", transcription.Name);
    }

    if (!extractor.IsConfigured)
    {
        jobsLogger.LogWarning(
            "Structure extraction ({Provider}) has no key configured: entries will keep their "
            + "transcript and park in needs_review. Set Anthropic:ApiKey.", extractor.Name);
    }

    var reportDelivery = app.Services.GetRequiredService<IReportDelivery>();
    var reportingOptions = app.Services.GetRequiredService<IOptions<ReportingOptions>>().Value;

    if (!reportDelivery.IsConfigured)
    {
        jobsLogger.LogWarning(
            "Report delivery ({Transport}) has no relay configured: confirmed entries will keep "
            + "their PDF but stop with delivery_not_configured. Set Reporting:Smtp:Host and "
            + "Reporting:FromAddress — locally, `docker compose up -d` runs Mailpit on "
            + "localhost:1025 with its inbox at http://localhost:8025.", reportDelivery.Name);
    }
    else
    {
        // Says what it is actually pointed at, and at what port — because the one configuration
        // that must never appear here is a direct send on port 25 from the VPS (ARCHITECTURE
        // §10). A start-up line naming the relay is how that gets noticed.
        jobsLogger.LogInformation(
            "Report delivery ({Transport}) via {Host}:{Port} ({Security}), from {From}; reports "
            + "go out in each project's own language.",
            reportDelivery.Name,
            reportingOptions.Smtp.Host,
            reportingOptions.Smtp.Port,
            reportingOptions.Smtp.Security,
            reportingOptions.FromAddress);
    }

    // The cron string, not the configured interval: this line states what the scheduler was
    // actually given, so it cannot assert a cadence that is not running.
    jobsLogger.LogInformation(
        "Background pipeline running: sweep on cron \"{SweepCron}\", {MaxAttempts} attempt(s) "
        + "per external call, stale after {StaleMinutes} min.",
        sweepCron,
        pipelineOptions.MaxAttempts,
        (int)pipelineOptions.StaleProcessingAfter.TotalMinutes);
}

app.Run();

internal record HealthResponse(string Status, string Service);

/// <summary>
/// The entry point class the top-level statements above compile into, made public so the test
/// host (<c>WebApplicationFactory&lt;Program&gt;</c>) can boot this exact application — the real
/// auth filter, validation filters, exception handlers and JSON policy included. Endpoint tests
/// that skip that wiring would skip precisely what has broken before.
/// </summary>
public partial class Program;
