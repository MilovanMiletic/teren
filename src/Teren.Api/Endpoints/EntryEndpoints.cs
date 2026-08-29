using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Api.Validation;
using Teren.Core.Entities;
using Teren.Core.Processing;
using Teren.Core.Storage;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Storage;
using Microsoft.Extensions.Options;

namespace Teren.Api.Endpoints;

/// <summary>
/// The upload path: the phone declares an entry, declares its files, uploads them straight to
/// object storage, and tells us when it is done. Media bytes never pass through here.
/// </summary>
public static class EntryEndpoints
{
    public static RouteGroupBuilder MapEntryEndpoints(this RouteGroupBuilder api)
    {
        var group = api.MapGroup("/entries").WithTags("Entries");

        group.MapPost("/", CreateEntryAsync)
            .AddEndpointFilter<ValidationFilter<CreateEntryRequest>>()
            .WithName("CreateEntry")
            .WithSummary("Accept an entry captured on a phone. Idempotent on the client UUID.")
            .Produces<EntryResponse>(StatusCodes.Status202Accepted)
            .Produces<EntryResponse>(StatusCodes.Status200OK);

        group.MapPost("/{id}/media", DeclareMediaAsync)
            .AddEndpointFilter<ValidationFilter<DeclareMediaRequest>>()
            .WithName("DeclareEntryMedia")
            .WithSummary("Declare files and receive one presigned PUT URL per file.")
            .Produces<DeclareMediaResponse>();

        group.MapPost("/{id}/complete", CompleteEntryAsync)
            .WithName("CompleteEntry")
            .WithSummary("Uploads finished: verify each object in storage and close the entry.")
            .Produces<CompleteEntryResponse>();

        group.MapPost("/{id}/confirm", ConfirmEntryAsync)
            .AddEndpointFilter<ValidationFilter<ConfirmEntryRequest>>()
            .WithName("ConfirmEntry")
            .WithSummary("Store the structure a human approved and mark the entry confirmed.")
            .Produces<EntryResponse>();

        group.MapGet("/{id}", GetEntryAsync)
            .WithName("GetEntry")
            .WithSummary("Entry status and extracted structure. This is the client's poll target.")
            .Produces<EntryResponse>();

        group.MapGet("/", ListEntriesAsync)
            .WithName("ListEntries")
            .WithSummary("Archive list, filtered by project and date range.")
            .Produces<EntryListResponse>();

        return api;
    }

    // ---------------------------------------------------------------- POST /api/entries

    private static async Task<IResult> CreateEntryAsync(
        CreateEntryRequest request,
        HttpContext http,
        TerenDbContext db,
        ILogger<Entry> logger,
        CancellationToken ct)
    {
        var entryId = request.Id!.Value;
        var projectId = request.ProjectId!.Value;
        var identity = http.GetDeviceIdentity();

        // Tenant-scoped by the global query filter: a project belonging to another company is
        // indistinguishable from one that does not exist.
        if (!await db.Projects.AnyAsync(p => p.Id == projectId, ct))
        {
            return ApiProblems.NotFound($"Project {projectId} was not found.");
        }

        var existing = await LoadEntryAsync(db, entryId, ct);
        if (existing is not null)
        {
            // Replay. The first declaration wins — an entry is evidence, and a retry is not a
            // licence to rewrite what was already accepted.
            logger.LogInformation("Entry {EntryId} replayed; returning current state.", entryId);
            return TypedResults.Ok(await ToResponseAsync(db, existing, ct));
        }

        var now = DateTime.UtcNow;
        var entry = new Entry
        {
            Id = entryId,
            CompanyId = identity.CompanyId,
            ProjectId = projectId,
            EntryDate = request.EntryDate!.Value,
            Status = EntryStatus.Received,
            // ReceivedAt stays null until /complete: the server has the entry's JSON, but not
            // yet the evidence. B4 picks up entries whose received_at is set.
            ReceivedAt = null,
            Latitude = request.Latitude,
            Longitude = request.Longitude,
            GpsAccuracyM = request.GpsAccuracyM,
            DeviceId = request.DeviceId ?? identity.DeviceId,
            CreatedAt = request.CreatedAt?.UtcDateTime ?? now,
        };

        db.Entries.Add(entry);

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex, "pk_entry"))
        {
            // Two copies of the same request in flight at once — the phone's retry timer racing
            // its own first attempt. The primary key settled it; we just report the winner.
            db.ChangeTracker.Clear();
            var winner = await LoadEntryAsync(db, entryId, ct);
            if (winner is null)
            {
                // The id exists, but not for this company. Same answer as "no such entry".
                logger.LogWarning(
                    "Entry {EntryId} exists outside the calling company; reporting not found.",
                    entryId);
                return ApiProblems.NotFound($"Entry {entryId} was not found.");
            }

            logger.LogInformation("Entry {EntryId} lost the insert race; returning the winner.", entryId);
            return TypedResults.Ok(await ToResponseAsync(db, winner, ct));
        }

        logger.LogInformation(
            "Entry {EntryId} accepted for project {ProjectId}, date {EntryDate}.",
            entry.Id, entry.ProjectId, entry.EntryDate);

        return TypedResults.Accepted(
            $"/api/entries/{entry.Id}", await ToResponseAsync(db, entry, ct));
    }

    // ------------------------------------------------- POST /api/entries/{id}/media

    private static async Task<IResult> DeclareMediaAsync(
        string id,
        DeclareMediaRequest request,
        TerenDbContext db,
        IObjectStorage storage,
        IOptions<StorageOptions> storageOptions,
        ILogger<Media> logger,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var entryId))
        {
            return ApiProblems.BadRequest("The entry id in the path is not a valid UUID.");
        }

        var entry = await db.Entries.FirstOrDefaultAsync(e => e.Id == entryId, ct);
        if (entry is null)
        {
            return ApiProblems.NotFound($"Entry {entryId} was not found.");
        }

        if (entry.Status != EntryStatus.Received)
        {
            // Past `received` the pipeline owns the entry; adding evidence underneath it would
            // change what a report was built from.
            return ApiProblems.Conflict(
                $"Entry {entryId} is {EntryStatusNames.ToWire(entry.Status)} and no longer accepts uploads.");
        }

        if (entry.ReceivedAt is not null)
        {
            // /complete sealed this entry's evidence set. The realistic way to arrive here is the
            // phone's outbox replaying a delayed declare after completion; accepting it would let
            // a file appear in an entry the server has already certified as whole, and the entry
            // would silently fall back out of `ready`. A correction is a new entry
            // (supersedes_entry_id), never an addition to a closed one.
            return ApiProblems.Conflict(
                $"Entry {entryId} was completed at {entry.ReceivedAt:O}; its evidence set is "
                + "sealed and no further media can be declared.");
        }

        var files = request.Files!;
        var requestedIds = files.Select(f => f.Id!.Value).ToList();

        var knownMedia = await db.Media
            .Where(m => requestedIds.Contains(m.Id))
            .ToListAsync(ct);

        var conflicting = knownMedia.FirstOrDefault(m => m.EntryId != entryId);
        if (conflicting is not null)
        {
            return ApiProblems.Conflict(
                $"Media {conflicting.Id} was already declared for a different entry.");
        }

        // At most MaxMediaPerEntry rows, so counting in memory is cheaper than three aggregates.
        var existingKinds = await db.Media
            .Where(m => m.EntryId == entryId)
            .Select(m => m.Kind)
            .ToListAsync(ct);

        var countsPerKind = new Dictionary<MediaKind, int>
        {
            [MediaKind.Audio] = existingKinds.Count(k => k == MediaKind.Audio),
            [MediaKind.Photo] = existingKinds.Count(k => k == MediaKind.Photo),
        };
        var totalCount = existingKinds.Count;

        var byId = knownMedia.ToDictionary(m => m.Id);
        var now = DateTime.UtcNow;
        var declared = new List<Media>(files.Count);

        foreach (var file in files)
        {
            var mediaId = file.Id!.Value;

            // The validator has already rejected anything that fails these, but the handler is
            // what writes the object key and the evidence record: it re-derives the values from
            // the policy rather than assuming a filter ran, so a future route registered without
            // the validation filter cannot silently produce a key with an empty extension.
            if (!MediaKindNames.TryParse(file.Kind, out var kind)
                || !MediaPolicy.TryResolveContentType(
                    kind, file.ContentType, out var contentType, out var extension)
                || !MediaPolicy.TryNormaliseSha256(file.Sha256, out var sha256)
                || file.ByteSize is not > 0
                || file.ByteSize > MediaPolicy.MaxBytesFor(kind))
            {
                return ApiProblems.BadRequest(
                    "A declared file has an unusable kind, content type, size or checksum.");
            }

            if (byId.TryGetValue(mediaId, out var existing))
            {
                // Re-declaration is how a client recovers an expired URL, so it must be free —
                // but only for the same file. A different checksum under the same id would make
                // the evidence record a lie.
                if (existing.Kind != kind
                    || existing.ContentType != contentType
                    || existing.ByteSize != file.ByteSize!.Value
                    || !string.Equals(existing.Sha256.TrimEnd(), sha256, StringComparison.Ordinal))
                {
                    return ApiProblems.Conflict(
                        $"Media {mediaId} was already declared with different content; "
                        + "a media declaration is immutable.");
                }

                declared.Add(existing);
                continue;
            }

            // Caps apply only to genuinely new rows: re-declaring an id already on this entry
            // was handled above and must stay free, because that is a retry.
            countsPerKind[kind]++;
            totalCount++;

            if (countsPerKind[kind] > MediaPolicy.MaxPerEntry(kind))
            {
                return ApiProblems.Conflict(kind == MediaKind.Audio
                    ? $"Entry {entryId} already has a voice note, and an entry carries at most "
                      + $"{MediaPolicy.MaxAudioPerEntry}. To retry an upload, re-declare the "
                      + "existing media id; to record something else, create a new entry."
                    : $"Entry {entryId} would exceed the limit of "
                      + $"{MediaPolicy.MaxPhotosPerEntry} photos per entry.");
            }

            if (totalCount > MediaPolicy.MaxMediaPerEntry)
            {
                return ApiProblems.Conflict(
                    $"Entry {entryId} would exceed the limit of "
                    + $"{MediaPolicy.MaxMediaPerEntry} media files per entry.");
            }

            var media = new Media
            {
                Id = mediaId,
                CompanyId = entry.CompanyId,
                EntryId = entry.Id,
                Kind = kind,
                ObjectKey = ObjectKeys.ForMedia(
                    entry.CompanyId, entry.ProjectId, entry.Id, mediaId, extension),
                ContentType = contentType,
                ByteSize = file.ByteSize!.Value,
                Sha256 = sha256,
                CapturedAt = file.CapturedAt?.UtcDateTime,
                UploadStatus = MediaUploadStatus.Pending,
                CreatedAt = now,
            };

            db.Media.Add(media);
            declared.Add(media);
        }

        // Ids this request tried to insert, as opposed to ones it merely re-declared. Only these
        // can collide on the primary key, and telling the two apart is what makes the catch below
        // able to distinguish a race from another tenant's id.
        var insertedIds = declared.Where(m => !byId.ContainsKey(m.Id)).Select(m => m.Id).ToList();

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex, "pk_media"))
        {
            db.ChangeTracker.Clear();

            // At least one id already exists, and from here two causes look identical: the
            // phone's retry racing its own first attempt (that row is this company's, so it is
            // visible again now the insert rolled back), or an id owned by another company
            // (never visible through the tenant filter, at any point). The second must answer
            // exactly as any other foreign id does — the plain 404 this route already returns
            // for an entry that does not exist — because a distinct answer would confirm that
            // someone else's media id is real. Same treatment as the pk_entry catch above.
            var visible = await db.Media
                .AsNoTracking()
                .Where(m => insertedIds.Contains(m.Id))
                .Select(m => m.Id)
                .ToListAsync(ct);

            if (visible.Count == 0)
            {
                logger.LogWarning(
                    "Entry {EntryId}: a declared media id exists outside the calling company; "
                    + "reporting not found.", entryId);
                return ApiProblems.NotFound($"Entry {entryId} was not found.");
            }

            return ApiProblems.Conflict(
                "One of the declared media ids was created concurrently; re-request the URLs.");
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex, "ux_media_object_key"))
        {
            // The key carries the company id, so this constraint can only be hit by this
            // company's own concurrent insert — never by another tenant's row.
            db.ChangeTracker.Clear();
            return ApiProblems.Conflict(
                "One of the declared media ids was created concurrently; re-request the URLs.");
        }

        // Signing happens only after the rows are durable, so no client ever holds a permission
        // for an object the database does not know about.
        var ttl = storageOptions.Value.UploadUrlTtl;
        var uploads = new List<MediaUploadTarget>(declared.Count);
        foreach (var media in declared)
        {
            if (media.UploadStatus == MediaUploadStatus.Verified)
            {
                // Already in storage and verified. Evidence is not overwritten.
                uploads.Add(new MediaUploadTarget(
                    media.Id, MediaKindNames.ToWire(media.Kind), media.ObjectKey,
                    MediaUploadStatusNames.ToWire(media.UploadStatus), null, null, null, null));
                continue;
            }

            // Local signature computation, not a call to storage (PROJECT.md principle 4).
            var presigned = await storage.CreatePresignedUploadAsync(
                media.ObjectKey, media.ContentType, ttl, ct);

            uploads.Add(new MediaUploadTarget(
                media.Id,
                MediaKindNames.ToWire(media.Kind),
                media.ObjectKey,
                MediaUploadStatusNames.ToWire(media.UploadStatus),
                presigned.Url,
                presigned.Method,
                presigned.RequiredHeaders,
                presigned.ExpiresAt));
        }

        logger.LogInformation(
            "Entry {EntryId}: issued {Count} upload target(s).", entryId, uploads.Count);

        return TypedResults.Ok(new DeclareMediaResponse(entryId, uploads));
    }

    // ---------------------------------------------- POST /api/entries/{id}/complete

    private static async Task<IResult> CompleteEntryAsync(
        string id,
        TerenDbContext db,
        IObjectStorage storage,
        IPipelineQueue pipeline,
        IOptions<StorageOptions> storageOptions,
        ILogger<Entry> logger,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var entryId))
        {
            return ApiProblems.BadRequest("The entry id in the path is not a valid UUID.");
        }

        var entry = await db.Entries.FirstOrDefaultAsync(e => e.Id == entryId, ct);
        if (entry is null)
        {
            return ApiProblems.NotFound($"Entry {entryId} was not found.");
        }

        var media = await db.Media
            .Where(m => m.EntryId == entryId)
            .OrderBy(m => m.CreatedAt)
            .ToListAsync(ct);

        if (entry.ReceivedAt is not null)
        {
            // Sealed by receipt: a previous /complete certified this evidence set, and the
            // pipeline may have taken the entry since. Re-verifying would be pointless work
            // against objects already vouched for, and — worse — could re-open a settled verdict
            // if storage were briefly unreachable. Report what is on record.
            return TypedResults.Ok(new CompleteEntryResponse(
                true, null, [], [], ToResponse(entry, media)));
        }

        if (entry.Status != EntryStatus.Received)
        {
            // Status advanced past `received` with no receipt. Unreachable as the API stands —
            // only creation writes Status and only the line below stamps ReceivedAt — and it
            // must stay that way, because B4's pickup predicate is
            // `status = received AND received_at IS NOT NULL` (ARCHITECTURE §6). Answering
            // `ready` here would certify an entry the server never recorded receiving, and
            // answering "not ready" would send the phone into a retry loop it can never win
            // (past `received`, /media refuses fresh upload URLs). So neither: this is a broken
            // row, it is reported as a server fault, and B4 cannot inherit the lie quietly.
            throw new InvalidOperationException(
                $"Entry {entryId} has status {EntryStatusNames.ToWire(entry.Status)} but no "
                + "received_at; only a successful /complete may advance an entry past receipt.");
        }

        // Storage-bound work inside a phone-facing request, and the one place in B3 where that
        // happens. Reviewed and accepted: a HEAD per object against the same datacentre is a few
        // milliseconds, the loop is bounded by MediaPolicy.MaxMediaPerEntry, each call is capped
        // by Storage:RequestTimeout, and the alternative — trusting the client that the bytes
        // arrived — is exactly the assumption evidence must not rest on. If it ever shows up in
        // latency, it moves into the B4 job.
        // One budget for the whole pass. Storage that answers slowly rather than not at all would
        // otherwise multiply the per-call timeout by the number of objects; a foreman waiting on
        // a site gets an answer inside a known bound, or gets told to try again.
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(storageOptions.Value.VerificationBudget);

        try
        {
            await VerifyMediaAsync(media, storage, entryId, logger, budget.Token);
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested
                                                 && !ct.IsCancellationRequested)
        {
            // The budget ran out, not the client's patience. Nothing is written: the entry keeps
            // whatever upload_status it had, and the client is told to come back.
            throw new ObjectStorageUnavailableException(
                "Verifying this entry's objects took longer than the allowed budget.");
        }

        var failed = media
            .Where(m => m.UploadStatus == MediaUploadStatus.Failed)
            .Select(m => m.Id)
            .ToList();

        var pending = media
            .Where(m => m.UploadStatus is MediaUploadStatus.Pending or MediaUploadStatus.Uploaded)
            .Select(m => m.Id)
            .ToList();

        var ready = failed.Count == 0 && pending.Count == 0;
        string? reason = null;

        if (ready)
        {
            // The moment the server holds the whole entry — JSON and every declared object.
            // From here the evidence set is sealed: see the gate at the top of this handler.
            entry.ReceivedAt = DateTime.UtcNow;
        }
        else
        {
            var problems = new List<string>(2);
            if (pending.Count > 0)
            {
                problems.Add($"{pending.Count} file(s) have not arrived in storage");
            }

            if (failed.Count > 0)
            {
                problems.Add($"{failed.Count} file(s) do not match the declared size");
            }

            reason = string.Join("; ", problems)
                + ". Request fresh upload URLs for them and call complete again.";
        }

        await db.SaveChangesAsync(ct);

        if (ready)
        {
            // Enqueue only after the receipt is durable, and never do the work here: STT and the
            // model call are external services, and this is a request a foreman is waiting on
            // (PROJECT.md principle 4). If this enqueue is lost — the process dies in the next
            // millisecond, Hangfire storage blinks — the entry is still `received` with a
            // receipt, which is exactly what the pipeline sweeper picks up.
            pipeline.EnqueueProcessing(entry.Id, entry.CompanyId);
        }

        logger.LogInformation(
            "Entry {EntryId} completion: ready={Ready}, {MediaCount} media, {FailedCount} failed.",
            entryId, ready, media.Count, failed.Count);

        return TypedResults.Ok(new CompleteEntryResponse(
            ready, reason, pending, failed, ToResponse(entry, media)));
    }

    /// <summary>
    /// Resolves every not-yet-verified object against storage. Mutates the tracked entities; the
    /// caller decides what the result means for the entry.
    /// </summary>
    private static async Task VerifyMediaAsync(
        IReadOnlyList<Media> media,
        IObjectStorage storage,
        Guid entryId,
        ILogger logger,
        CancellationToken ct)
    {
        foreach (var item in media.Where(m => m.UploadStatus != MediaUploadStatus.Verified))
        {
            var stored = await storage.HeadAsync(item.ObjectKey, ct);

            item.UploadStatus = stored switch
            {
                // Nothing at that key. The upload has not happened, or has not finished — a
                // waiting state, not a verdict. Recording it as `failed` would put a permanent
                // black mark in the evidence record for a file that is merely late.
                null => MediaUploadStatus.Pending,
                // Present, but not the bytes that were declared. That is a real failure.
                _ when stored.ByteSize != item.ByteSize => MediaUploadStatus.Failed,
                _ => MediaUploadStatus.Verified,
            };

            if (item.UploadStatus == MediaUploadStatus.Failed)
            {
                logger.LogWarning(
                    "Entry {EntryId}: media {MediaId} failed verification "
                    + "(declared {DeclaredBytes} bytes, stored {StoredBytes}).",
                    entryId, item.Id, item.ByteSize, stored!.ByteSize);
            }
        }
    }

    // ----------------------------------------------- POST /api/entries/{id}/confirm

    /// <summary>
    /// The mandatory gate before any report is sent (PROJECT.md principle 5). It writes exactly
    /// one column — <c>corrected</c> — and stamps <c>confirmed_at</c>.
    /// </summary>
    private static async Task<IResult> ConfirmEntryAsync(
        string id,
        ConfirmEntryRequest request,
        TerenDbContext db,
        ILogger<Entry> logger,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var entryId))
        {
            return ApiProblems.BadRequest("The entry id in the path is not a valid UUID.");
        }

        var entry = await db.Entries.FirstOrDefaultAsync(e => e.Id == entryId, ct);
        if (entry is null)
        {
            return ApiProblems.NotFound($"Entry {entryId} was not found.");
        }

        if (entry.ReportedAt is not null)
        {
            // Immutable, and this is the application half of that promise; the Postgres trigger
            // is the half that holds against any SQL. A correction is a new entry pointing back
            // via supersedes_entry_id, never an edit to the one already sent.
            return ApiProblems.Conflict(
                $"Entry {entryId} was reported at {entry.ReportedAt:O} and is immutable. "
                + "Create a correction entry with supersedes_entry_id instead.");
        }

        // What may be confirmed: something the pipeline has finished with. `awaiting_confirmation`
        // is the ordinary path; `needs_review` is deliberately allowed, because that is the
        // typed-shorthand fallback — an entry whose transcription or extraction failed still has
        // to be completable by a human typing what happened. `confirmed` is allowed so a person
        // can revise his own answer up until the report goes out.
        if (entry.Status is not (EntryStatus.AwaitingConfirmation
            or EntryStatus.NeedsReview
            or EntryStatus.Confirmed))
        {
            return ApiProblems.Conflict(
                $"Entry {entryId} is {EntryStatusNames.ToWire(entry.Status)}; there is nothing to "
                + "confirm until the pipeline has finished with it.");
        }

        var corrected = request.Corrected!.ToJsonString();

        // Compared as JSON, not as text. Postgres normalises jsonb on the way in — keys
        // reordered, whitespace dropped — so what comes back out is never byte-identical to what
        // the client sent, and a string comparison here would silently miss every replay and
        // re-stamp confirmed_at each time the phone retried.
        if (entry.Status == EntryStatus.Confirmed
            && JsonNode.DeepEquals(ParseJson(entry.Corrected), request.Corrected))
        {
            // A replay: same entry, same approved structure. Free, and confirmed_at keeps the
            // moment the human actually decided rather than the moment his phone retried.
            logger.LogInformation(
                "Entry {EntryId} confirmation replayed; nothing changed.", entryId);
            return TypedResults.Ok(await ToResponseAsync(db, entry, ct));
        }

        // raw_transcript and structure are not touched here, by construction. They are two thirds
        // of the (transcript, extracted, corrected) triple that is this product's eval set and
        // training signal (ARCHITECTURE §9.3); overwriting either with the human's answer would
        // destroy the only record of what the model actually got wrong.
        entry.Corrected = corrected;
        entry.Status = EntryStatus.Confirmed;
        entry.ConfirmedAt = DateTime.UtcNow;
        entry.FailureReason = null;

        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "Entry {EntryId} confirmed (structure {StructureState}).",
            entryId, entry.Structure is null ? "absent" : "present");

        return TypedResults.Ok(await ToResponseAsync(db, entry, ct));
    }

    // ------------------------------------------------------- GET /api/entries/{id}

    private static async Task<IResult> GetEntryAsync(
        string id, TerenDbContext db, CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var entryId))
        {
            return ApiProblems.BadRequest("The entry id in the path is not a valid UUID.");
        }

        var entry = await db.Entries.AsNoTracking().FirstOrDefaultAsync(e => e.Id == entryId, ct);
        if (entry is null)
        {
            return ApiProblems.NotFound($"Entry {entryId} was not found.");
        }

        return TypedResults.Ok(await ToResponseAsync(db, entry, ct));
    }

    // ----------------------------------------------------------- GET /api/entries

    private const int DefaultListLimit = 50;
    private const int MaxListLimit = 200;

    private static async Task<IResult> ListEntriesAsync(
        TerenDbContext db,
        // Snake_case is the canonical spelling everywhere in this API; camelCase is accepted on
        // this one parameter because it is the spelling the frontend contract was drafted with.
        [FromQuery(Name = "project_id")] Guid? projectIdSnake,
        [FromQuery(Name = "projectId")] Guid? projectIdCamel,
        [FromQuery(Name = "from")] DateOnly? from,
        [FromQuery(Name = "to")] DateOnly? to,
        [FromQuery(Name = "limit")] int? limit,
        CancellationToken ct)
    {
        var projectId = projectIdSnake ?? projectIdCamel;

        if (projectId is not null && !await db.Projects.AnyAsync(p => p.Id == projectId, ct))
        {
            return ApiProblems.NotFound($"Project {projectId} was not found.");
        }

        if (from is not null && to is not null && from > to)
        {
            return ApiProblems.BadRequest("The from date must not be after the to date.");
        }

        var take = Math.Clamp(limit ?? DefaultListLimit, 1, MaxListLimit);

        var query = db.Entries.AsNoTracking();
        if (projectId is not null)
        {
            query = query.Where(e => e.ProjectId == projectId);
        }

        if (from is not null)
        {
            query = query.Where(e => e.EntryDate >= from);
        }

        if (to is not null)
        {
            query = query.Where(e => e.EntryDate <= to);
        }

        var entries = await query
            .OrderByDescending(e => e.EntryDate)
            .ThenByDescending(e => e.CreatedAt)
            .Take(take)
            .ToListAsync(ct);

        var entryIds = entries.Select(e => e.Id).ToList();
        var media = await db.Media
            .AsNoTracking()
            .Where(m => entryIds.Contains(m.EntryId))
            .Select(m => new { m.EntryId, m.Kind })
            .ToListAsync(ct);

        var mediaByEntry = media.ToLookup(m => m.EntryId);

        var items = entries
            .Select(e => new EntryListItemResponse(
                e.Id,
                e.ProjectId,
                e.EntryDate,
                EntryStatusNames.ToWire(e.Status),
                Utc(e.CreatedAt),
                Utc(e.ReceivedAt),
                Utc(e.ReportedAt),
                mediaByEntry[e.Id].Count(m => m.Kind == MediaKind.Photo),
                mediaByEntry[e.Id].Any(m => m.Kind == MediaKind.Audio)))
            .ToList();

        return TypedResults.Ok(new EntryListResponse(items, items.Count));
    }

    // ------------------------------------------------------------------- helpers

    private static Task<Entry?> LoadEntryAsync(
        TerenDbContext db, Guid entryId, CancellationToken ct) =>
        db.Entries.AsNoTracking().FirstOrDefaultAsync(e => e.Id == entryId, ct);

    private static async Task<EntryResponse> ToResponseAsync(
        TerenDbContext db, Entry entry, CancellationToken ct)
    {
        var media = await db.Media
            .AsNoTracking()
            .Where(m => m.EntryId == entry.Id)
            .OrderBy(m => m.CreatedAt)
            .ToListAsync(ct);

        return ToResponse(entry, media);
    }

    private static EntryResponse ToResponse(Entry entry, IReadOnlyList<Media> media) => new(
        entry.Id,
        entry.ProjectId,
        entry.EntryDate,
        EntryStatusNames.ToWire(entry.Status),
        Utc(entry.CreatedAt),
        Utc(entry.ReceivedAt),
        Utc(entry.ConfirmedAt),
        Utc(entry.ReportedAt),
        entry.FailureReason,
        entry.RawTranscript,
        entry.Latitude,
        entry.Longitude,
        entry.GpsAccuracyM,
        entry.DeviceId,
        entry.SupersedesEntryId,
        ParseJson(entry.Structure),
        ParseJson(entry.Corrected),
        ParseJson(entry.Weather),
        media.Select(m => new MediaResponse(
            m.Id,
            MediaKindNames.ToWire(m.Kind),
            m.ContentType,
            m.ByteSize,
            m.Sha256.TrimEnd(),
            m.ObjectKey,
            MediaUploadStatusNames.ToWire(m.UploadStatus),
            Utc(m.CapturedAt),
            Utc(m.CreatedAt))).ToList());

    /// <summary>JSONB columns are opaque strings to the server; they go out as JSON, not as a
    /// quoted string, and are never reshaped on the way.</summary>
    private static JsonNode? ParseJson(string? json) =>
        string.IsNullOrWhiteSpace(json) ? null : JsonNode.Parse(json);

    private static DateTimeOffset Utc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static DateTimeOffset? Utc(DateTime? value) =>
        value is null ? null : Utc(value.Value);

    private static bool IsUniqueViolation(DbUpdateException ex, string constraintName) =>
        ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } pg
        && string.Equals(pg.ConstraintName, constraintName, StringComparison.Ordinal);
}
