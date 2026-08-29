using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Auth;
using Teren.Api.Contracts;
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

builder.Services.AddSingleton<IValidator<CreateEntryRequest>, CreateEntryRequestValidator>();
builder.Services.AddSingleton<IValidator<DeclareMediaRequest>, DeclareMediaRequestValidator>();

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

app.Run();

internal record HealthResponse(string Status, string Service);
