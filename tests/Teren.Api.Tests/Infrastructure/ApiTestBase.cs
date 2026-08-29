using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Microsoft.Extensions.DependencyInjection;
using Teren.Core.Processing;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Processing;

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

    // ------------------------------------------------------------ arrange helpers

    /// <summary>An accepted entry on project A1. Fails loudly if the API did not accept it, so a
    /// broken arrange never masquerades as a failed assertion.</summary>
    protected async Task<Guid> GivenEntryAsync(Guid? id = null, Guid? projectId = null)
    {
        var entryId = id ?? Guid.NewGuid();
        var response = await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, projectId ?? TestIds.ProjectA1));

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
