using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;
using FluentValidation;
using Hangfire;
using Microsoft.Extensions.Options;
using Serilog;
using Teren.Api.Hangfire;
using Teren.Core.Ai;
using Teren.Infrastructure.Processing;
using Teren.Api.Contracts;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Auth;
using Teren.Api.Endpoints;
using Teren.Api.Errors;
using Teren.Api.Validation;
using Teren.Core.Storage;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Seeding;
using Teren.Infrastructure.Storage;
using Teren.Infrastructure.Tenancy;

var builder = WebApplication.CreateBuilder(args);

// Structured logging to stdout (ARCHITECTURE §13). The pipeline pushes the entry id into a log
// scope, so every line about one entry carries it — which is the difference between reading a
// job failure and guessing at one. Nothing personal is ever logged: ids, not names or addresses.
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .WriteTo.Console(
        outputTemplate:
        "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}"));

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

// Scoped tenant context: DeviceTokenAuthFilter sets CompanyId from the caller's token before any
// handler runs. Query filters are deny-by-default, so an unset tenant returns no rows rather
// than everyone's rows.
builder.Services.AddScoped<TenantContext>();

var connectionString = builder.Configuration.GetConnectionString("Postgres")
    ?? throw new InvalidOperationException(
        "Connection string 'Postgres' is not configured. Locally it lives in " +
        "appsettings.Development.json; in production set ConnectionStrings__Postgres.");

builder.Services.AddDbContext<TerenDbContext>(options => options.UseNpgsql(connectionString));

// Object storage: presigned PUT URLs out, HEAD verification back. Local values come from
// appsettings.Development.json (throwaway MinIO credentials); production sets Storage__* env vars.
builder.Services
    .AddOptions<StorageOptions>()
    .Bind(builder.Configuration.GetSection(StorageOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddSingleton<IObjectStorage, S3ObjectStorage>();

// M0 auth (ARCHITECTURE §12): one static device token. Missing configuration stops startup —
// an API that silently accepts anonymous writes is worse than one that does not boot.
builder.Services
    .AddOptions<DeviceAuthOptions>()
    .Bind(builder.Configuration.GetSection(DeviceAuthOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddScoped<IDeviceAuthenticator, StaticTokenDeviceAuthenticator>();

// B4: transcription, extraction, the processor and the sweeper.
builder.Services.AddTerenPipeline(builder.Configuration);

// Hangfire in the same process as the API (ARCHITECTURE §4). Switchable off so the upload path
// — which needs no job server at all — stays runnable and testable without one.
builder.Services.AddTerenJobs(builder.Configuration, connectionString);

builder.Services.AddSingleton<IValidator<CreateEntryRequest>, CreateEntryRequestValidator>();
builder.Services.AddSingleton<IValidator<DeclareMediaRequest>, DeclareMediaRequestValidator>();
builder.Services.AddSingleton<IValidator<ConfirmEntryRequest>, ConfirmEntryRequestValidator>();

var corsOrigins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins(corsOrigins).AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

// One-shot maintenance commands:
//   dotnet run --project src/Teren.Api -- migrate   apply pending EF migrations
//   dotnet run --project src/Teren.Api -- seed      migrate + seed the demo data (idempotent)
if (args.Contains("migrate") || args.Contains("seed"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<TerenDbContext>();

    await db.Database.MigrateAsync();
    Console.WriteLine("Migrations applied.");

    if (args.Contains("seed"))
    {
        var inserted = await DemoSeeder.SeedAsync(db);
        Console.WriteLine(inserted == 0
            ? "Demo data already present; nothing inserted."
            : $"Demo data seeded: {inserted} row(s) inserted.");
    }

    return;
}

app.UseExceptionHandler();
app.UseStatusCodePages();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
else
{
    app.UseHttpsRedirection();
}

app.UseCors();

app.MapGet("/health", () => Results.Ok(new HealthResponse("ok", "teren-api")));

// Everything under /api is behind the device token, which also resolves the tenant. Adding a
// route to this group is all it takes to be tenant-scoped and authenticated.
var api = app.MapGroup("/api").AddEndpointFilter<DeviceTokenAuthFilter>();

api.MapProjectEndpoints();
api.MapEntryEndpoints();

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
