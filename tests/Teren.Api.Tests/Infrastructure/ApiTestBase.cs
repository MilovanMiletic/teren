using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Microsoft.Extensions.DependencyInjection;
using Teren.Core.Identity;
using Teren.Core.Processing;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Processing;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// Every endpoint test starts from the same known database: truncated, then the two companies
/// and three projects of the baseline. No test inherits another test's rows, so a failure names
/// one cause.
/// </summary>
[Collection(TerenCollection.Name)]
public abstract class ApiTestBase(TerenTestApp app) : IAsyncLifetime
{
    protected TerenTestApp App { get; } = app;

    protected FakeObjectStorage Storage => App.Storage;

    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Authenticated as company A's device — the ordinary caller.</summary>
    protected HttpClient Client { get; private set; } = null!;

    public virtual async ValueTask InitializeAsync()
    {
        await App.ResetAsync();
        Client = App.CreateClient();
    }

    public virtual ValueTask DisposeAsync()
    {
        Client?.Dispose();
        return ValueTask.CompletedTask;
    }

    // ------------------------------------------------------------ identity arrange helpers

    /// <summary>
    /// The password every seeded admin in this suite has. Long enough to satisfy
    /// <c>PasswordPolicy</c>, and obviously a test value.
    /// </summary>
    protected const string AdminPassword = "teren-test-password-not-a-secret";

    /// <summary>
    /// Hashed <b>once per process</b>. 600 000 PBKDF2 iterations is ~200–400 ms by design, and
    /// paying it per arranged admin would add tens of seconds to the suite for no coverage —
    /// <see cref="PasswordHashTests"/> is what proves the hash, and every login test still pays a
    /// real verify.
    /// </summary>
    private static readonly Lazy<string> SharedAdminPasswordHash =
        new(() => PasswordHash.Hash(AdminPassword));

    /// <summary>An admin of the given company, with a password he can sign in with.</summary>
    protected async Task<AppUser> GivenCompanyAdminAsync(
        Guid? id = null, Guid? companyId = null, string? email = null, bool withPassword = true)
    {
        var admin = new AppUser
        {
            Id = id ?? TestIds.CompanyAdminA,
            CompanyId = companyId ?? TestIds.CompanyA,
            Role = AppUserRole.CompanyAdmin,
            Username = null,
            DisplayName = "Petar Petrović",
            Email = email ?? TestIds.CompanyAdminAEmail,
            PasswordHash = withPassword ? SharedAdminPasswordHash.Value : null,
            Language = "sr",
            CreatedAt = DateTime.UtcNow,
        };

        await using var identity = App.CreateIdentityDbContext();
        identity.Users.Add(admin);
        await identity.SaveChangesAsync(Ct);

        return admin;
    }

    /// <summary>Teren staff: no company, by constraint as well as by convention.</summary>
    protected async Task<AppUser> GivenSuperAdminAsync(string? email = null)
    {
        var admin = new AppUser
        {
            Id = TestIds.SuperAdmin,
            CompanyId = null,
            Role = AppUserRole.SuperAdmin,
            Username = null,
            DisplayName = "Teren Staff",
            Email = email ?? TestIds.SuperAdminEmail,
            PasswordHash = SharedAdminPasswordHash.Value,
            Language = "sr",
            CreatedAt = DateTime.UtcNow,
        };

        await using var identity = App.CreateIdentityDbContext();
        identity.Users.Add(admin);
        await identity.SaveChangesAsync(Ct);

        return admin;
    }

    /// <summary>
    /// Signs in through the real <c>POST /auth/login</c> and returns a client carrying the session
    /// token. Deliberately not a hand-written <c>admin_session</c> row: the thing under test in
    /// every admin test is that a token issued by the login route authenticates on the API, and a
    /// fixture that inserted the row itself would prove only that the fixture works.
    /// </summary>
    protected async Task<HttpClient> SignInAsync(string email, string password = AdminPassword)
    {
        using var anonymous = App.CreateAnonymousClient();

        var response = await anonymous.PostJson(
            "/auth/login",
            new JsonObject { ["email"] = email, ["password"] = password });

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var token = (await response.JsonAsync()).GetText("session_token");

        return App.CreateClientWithToken(token);
    }

    /// <summary>A company admin, created and signed in, in one step.</summary>
    protected async Task<HttpClient> GivenCompanyAdminClientAsync(
        Guid? id = null, Guid? companyId = null, string? email = null)
    {
        var admin = await GivenCompanyAdminAsync(id, companyId, email);
        return await SignInAsync(admin.Email!);
    }

    protected async Task<HttpClient> GivenSuperAdminClientAsync()
    {
        var admin = await GivenSuperAdminAsync();
        return await SignInAsync(admin.Email!);
    }

    /// <summary>Reads a worker row straight from the identity model, past every handler.</summary>
    protected async Task<AppUser?> LoadUserAsync(Guid userId)
    {
        await using var identity = App.CreateIdentityDbContext();
        return await identity.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, Ct);
    }

    protected async Task<List<Device>> LoadDevicesAsync(Guid userId)
    {
        await using var identity = App.CreateIdentityDbContext();
        return await identity.Devices.AsNoTracking()
            .Where(d => d.UserId == userId)
            .OrderBy(d => d.CreatedAt)
            .ToListAsync(Ct);
    }

    /// <summary>
    /// The phones the <em>test</em> activated, oldest first — the fixture's own demo device
    /// excluded.
    /// <para>
    /// The baseline already gives the seeded worker a phone (<see cref="TestIds.DeviceA"/>), which
    /// is not noise: it is exactly the state a man replacing a broken phone is in, and activation
    /// correctly supersedes it. Counting it as if it were a device under test would make every
    /// "exactly one device" assertion say two, so the assertions name what they mean instead.
    /// </para>
    /// </summary>
    protected async Task<List<Device>> NewlyActivatedDevicesAsync(Guid? userId = null) =>
        [.. (await LoadDevicesAsync(userId ?? TestIds.WorkerA))
            .Where(d => d.Id != TestIds.DeviceA)];

    protected async Task<List<ActivationCode>> LoadActivationCodesAsync(Guid userId)
    {
        await using var identity = App.CreateIdentityDbContext();
        return await identity.ActivationCodes.AsNoTracking()
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.CreatedAt)
            .ToListAsync(Ct);
    }

    protected async Task<List<AdminAudit>> LoadAuditAsync()
    {
        await using var identity = App.CreateIdentityDbContext();
        return await identity.AdminAudits.AsNoTracking()
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(Ct);
    }

    // ------------------------------------------------------------ arrange helpers

    /// <summary>An accepted entry on project A1. Fails loudly if the API did not accept it, so a
    /// broken arrange never masquerades as a failed assertion.</summary>
    /// <param name="entryDate">
    /// The day of work. Left to <c>Wire.Today</c> unless a test needs two entries to be
    /// distinguishable by date — which a correction's report does, since the report names the
    /// superseded record by its date and by nothing else.
    /// </param>
    /// <param name="supersedes">The entry this one corrects, posted the way a phone posts it.</param>
    protected async Task<Guid> GivenEntryAsync(
        Guid? id = null,
        Guid? projectId = null,
        DateOnly? entryDate = null,
        Guid? supersedes = null)
    {
        var entryId = id ?? Guid.NewGuid();
        var body = Wire.Entry(entryId, projectId ?? TestIds.ProjectA1, entryDate);

        if (supersedes is { } supersededId)
        {
            body["supersedes_entry_id"] = supersededId.ToString();
        }

        var response = await Client.PostJson("/api/entries", body);

        response.StatusCode.ShouldBe(
            HttpStatusCode.Accepted, await response.TextAsync());

        return entryId;
    }

    /// <summary>Declares media on an entry and returns the declare response body.</summary>
    protected async Task<JsonElement> GivenMediaAsync(Guid entryId, params JsonObject[] files)
    {
        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(files));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        return await response.JsonAsync();
    }

    /// <summary>
    /// Pretends the phone finished every declared upload: each object appears in storage at the
    /// declared size, which is exactly what <c>/complete</c> checks.
    /// </summary>
    protected async Task GivenUploadsFinishedAsync(Guid entryId, long? actualByteSize = null)
    {
        foreach (var media in await LoadMediaAsync(entryId))
        {
            Storage.PutObject(media.ObjectKey, actualByteSize ?? media.ByteSize);
        }
    }

    protected Task<HttpResponseMessage> CompleteAsync(Guid entryId) =>
        Client.PostNothing($"/api/entries/{entryId}/complete");

    /// <summary>
    /// Deep-clones the payload, so the same object can be confirmed twice — which is exactly
    /// what a phone replaying a confirmation does, and therefore the case the idempotency test
    /// needs. (A JsonNode cannot be attached to two parents; same reason as <c>Wire.Files</c>.)
    /// </summary>
    protected Task<HttpResponseMessage> ConfirmAsync(Guid entryId, JsonNode corrected) =>
        Client.PostJson(
            $"/api/entries/{entryId}/confirm",
            new JsonObject { ["corrected"] = corrected.DeepClone() });

    /// <summary>
    /// Declares a voice note whose declared checksum is the checksum of <paramref name="bytes"/>,
    /// puts exactly those bytes in storage, and completes the entry — the state B4 picks up.
    /// </summary>
    protected async Task<Guid> GivenCompletedEntryWithAudioAsync(
        Guid entryId, byte[]? bytes = null, Guid? projectId = null)
    {
        bytes ??= Wire.AudioBytes();
        var audioId = Guid.NewGuid();

        await GivenEntryAsync(entryId, projectId);
        await GivenMediaAsync(
            entryId,
            Wire.Audio(audioId, bytes.LongLength, sha256: Wire.Sha256OfBytes(bytes)));

        var audio = (await LoadMediaAsync(entryId)).Single(m => m.Id == audioId);
        Storage.PutObject(audio.ObjectKey, bytes);

        var completed = await CompleteAsync(entryId);
        completed.StatusCode.ShouldBe(HttpStatusCode.OK, await completed.TextAsync());
        (await completed.JsonAsync()).GetProperty("ready").GetBoolean()
            .ShouldBeTrue("the arrange did not reach a completed entry");

        return audioId;
    }

    // ------------------------------------------------------------ pipeline drivers

    /// <summary>
    /// Runs the real <see cref="EntryProcessor"/> out of the host's container, exactly as the
    /// Hangfire job would, in its own scope with its own DbContext — so nothing under test is
    /// helped along by entities the test happens to have tracked.
    /// </summary>
    protected async Task<EntryProcessingOutcome> ProcessAsync(Guid entryId, Guid? companyId = null)
    {
        await using var scope = App.Factory.Services.CreateAsyncScope();
        var processor = scope.ServiceProvider.GetRequiredService<EntryProcessor>();
        return await processor.ProcessAsync(entryId, companyId ?? TestIds.CompanyA, Ct);
    }

    /// <summary>
    /// Moves an entry's claim timestamp back in time — the only way to say "this pass has been
    /// running longer than <c>Pipeline:StaleProcessingAfter</c>" without waiting 45 minutes. Used
    /// both to arrange an abandoned entry and, from inside a provider hook, to age a pass that is
    /// still running.
    /// </summary>
    protected async Task SetProcessingStartedAsync(Guid entryId, DateTime startedAt)
    {
        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
        entry.ProcessingStartedAt = startedAt;
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>
    /// Runs the real <see cref="EntryReporter"/> out of the host's container, exactly as the
    /// Hangfire job would, in its own scope with its own DbContext.
    /// </summary>
    protected async Task<ReportOutcome> ReportAsync(Guid entryId, Guid? companyId = null)
    {
        await using var scope = App.Factory.Services.CreateAsyncScope();
        var reporter = scope.ServiceProvider.GetRequiredService<EntryReporter>();
        return await reporter.ReportAsync(entryId, companyId ?? TestIds.CompanyA, Ct);
    }

    /// <summary>An entry taken all the way to <c>confirmed</c> — the state B6 picks up — with
    /// whatever photographs the test asked for, their real checksums declared and their real
    /// bytes in storage.</summary>
    protected async Task<Guid> GivenConfirmedEntryAsync(
        Guid? id = null,
        Guid? projectId = null,
        int photos = 0,
        JsonNode? corrected = null,
        DateOnly? entryDate = null,
        Guid? supersedes = null)
    {
        var entryId = id ?? Guid.NewGuid();
        var audioBytes = Wire.AudioBytes();
        var audioId = Guid.NewGuid();

        await GivenEntryAsync(entryId, projectId, entryDate, supersedes);

        var files = new List<JsonObject>
        {
            Wire.Audio(audioId, audioBytes.LongLength, sha256: Wire.Sha256OfBytes(audioBytes)),
        };

        var photoBytes = new Dictionary<Guid, byte[]>();
        for (var index = 0; index < photos; index++)
        {
            var photoId = Guid.NewGuid();
            var bytes = Wire.PhotoBytes(index);
            photoBytes[photoId] = bytes;
            files.Add(Wire.Photo(
                photoId, bytes.LongLength, "image/png", Wire.Sha256OfBytes(bytes)));
        }

        await GivenMediaAsync(entryId, [.. files]);

        foreach (var media in await LoadMediaAsync(entryId))
        {
            Storage.PutObject(
                media.ObjectKey,
                media.Kind == MediaKind.Audio ? audioBytes : photoBytes[media.Id]);
        }

        var completed = await CompleteAsync(entryId);
        completed.StatusCode.ShouldBe(HttpStatusCode.OK, await completed.TextAsync());

        await ProcessAsync(entryId);

        var confirmed = await ConfirmAsync(entryId, corrected ?? DefaultCorrected());
        confirmed.StatusCode.ShouldBe(HttpStatusCode.OK, await confirmed.TextAsync());

        (await LoadEntryAsync(entryId))!.Status.ShouldBe(
            EntryStatus.Confirmed, "the arrange did not reach a confirmed entry");

        return entryId;
    }

    /// <summary>A plausible approved day, in the shape ARCHITECTURE §6 fixes for schema v1.</summary>
    protected static JsonObject DefaultCorrected() => new()
    {
        ["schema_version"] = 1,
        ["work_done"] = new JsonArray(
            new JsonObject
            {
                ["description"] = "Razvod tople i hladne vode od kotla do kupatila",
                ["location"] = "zapadno krilo, 2. sprat",
                ["quantity"] = new JsonObject { ["value"] = 40, ["unit"] = "m" },
            }),
        ["headcount"] = new JsonObject
        {
            ["total"] = 3,
            ["roles"] = new JsonArray(
                new JsonObject { ["role"] = "vodoinstalater", ["count"] = 3 }),
        },
        ["materials"] = new JsonArray(
            new JsonObject
            {
                ["name"] = "PPR cev 25mm",
                ["quantity"] = new JsonObject { ["value"] = 40, ["unit"] = "m" },
                ["delivered"] = true,
            }),
        ["blockers"] = new JsonArray(
            new JsonObject
            {
                ["description"] = "čeka se štemovanje",
                ["waiting_on"] = "električari",
            }),
        ["hidden_work"] = new JsonArray(
            new JsonObject { ["description"] = "cevi u zidu pre zatvaranja" }),
        ["notes"] = "Sutra nastavak na trećem spratu.",
    };

    protected async Task<Report?> LoadReportAsync(Guid entryId, Guid? companyId = null)
    {
        await using var db = App.CreateDbContext(companyId ?? TestIds.CompanyA);
        return await db.Reports.AsNoTracking()
            .FirstOrDefaultAsync(r => r.EntryId == entryId, Ct);
    }

    /// <summary>Writes a report row straight to the database — for arranging states the pass
    /// will not produce on its own, such as a claim another worker already holds.</summary>
    protected async Task InsertReportAsync(Report report)
    {
        await using var db = App.CreateDbContext(companyId: null);
        db.Reports.Add(report);
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>Edits a project — its distribution list, its report language — without going
    /// through an API that does not yet expose either.</summary>
    protected async Task UpdateProjectAsync(Guid projectId, Action<Project> change)
    {
        await using var db = App.CreateDbContext(companyId: null);
        var project = await db.Projects.IgnoreQueryFilters()
            .FirstAsync(p => p.Id == projectId, Ct);
        change(project);
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>Moves a report's claim timestamp back in time — the only way to say "this send
    /// has been running longer than <c>Reporting:StaleAfter</c>" without waiting half an hour.</summary>
    protected async Task SetReportAttemptStartedAsync(Guid reportId, DateTime startedAt)
    {
        await using var db = App.CreateDbContext(companyId: null);
        var report = await db.Reports.IgnoreQueryFilters().FirstAsync(r => r.Id == reportId, Ct);
        report.AttemptStartedAt = startedAt;
        await db.SaveChangesAsync(Ct);
    }

    protected async Task<SweepResult> SweepAsync()
    {
        await using var scope = App.Factory.Services.CreateAsyncScope();
        var sweeper = scope.ServiceProvider.GetRequiredService<PipelineSweeper>();
        return await sweeper.SweepAsync(Ct);
    }

    // ------------------------------------------------------------ database reads

    /// <summary>Reads through the tenant filter, as the application does.</summary>
    protected async Task<Entry?> LoadEntryAsync(Guid entryId, Guid? companyId = null)
    {
        await using var db = App.CreateDbContext(companyId ?? TestIds.CompanyA);
        return await db.Entries.AsNoTracking().FirstOrDefaultAsync(e => e.Id == entryId, Ct);
    }

    /// <summary>Reads past the tenant filter — for asserting that a row does or does not exist at
    /// all, which is a different question from whether the caller may see it.</summary>
    protected async Task<int> CountEntriesAsync(Guid entryId)
    {
        await using var db = App.CreateDbContext(companyId: null);
        return await db.Entries.IgnoreQueryFilters().CountAsync(e => e.Id == entryId, Ct);
    }

    protected async Task<List<Media>> LoadMediaAsync(Guid entryId, Guid? companyId = null)
    {
        await using var db = App.CreateDbContext(companyId ?? TestIds.CompanyA);
        return await db.Media.AsNoTracking()
            .Where(m => m.EntryId == entryId)
            .OrderBy(m => m.CreatedAt)
            .ToListAsync(Ct);
    }

    protected async Task<Media?> LoadMediumAsync(Guid mediaId)
    {
        await using var db = App.CreateDbContext(TestIds.CompanyA);
        return await db.Media.AsNoTracking().FirstOrDefaultAsync(m => m.Id == mediaId, Ct);
    }

    /// <summary>Writes a row straight to the database, bypassing the API — for arranging states
    /// the API will not produce (another tenant's entry, a reported entry).</summary>
    protected async Task InsertEntryAsync(Entry entry)
    {
        await using var db = App.CreateDbContext(companyId: null);
        db.Entries.Add(entry);
        await db.SaveChangesAsync(Ct);
    }

    /// <summary>Writes a media row straight to the database, bypassing the API — for arranging
    /// another tenant's media, which the API will never produce for this caller.</summary>
    protected async Task InsertMediaAsync(Media media)
    {
        await using var db = App.CreateDbContext(companyId: null);
        db.Media.Add(media);
        await db.SaveChangesAsync(Ct);
    }

    protected static Entry NewEntry(
        Guid id,
        Guid companyId,
        Guid projectId,
        EntryStatus status = EntryStatus.Received,
        DateTime? reportedAt = null,
        string? rawTranscript = null,
        DateTime? receivedAt = null) => new()
        {
            Id = id,
            CompanyId = companyId,
            ProjectId = projectId,
            EntryDate = Wire.Today,
            Status = status,
            RawTranscript = rawTranscript,
            CreatedAt = DateTime.UtcNow,
            ReceivedAt = receivedAt,
            ReportedAt = reportedAt,
        };
}
