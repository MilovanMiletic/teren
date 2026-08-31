using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Storage;
using Teren.Infrastructure.Storage;

namespace Teren.Api.Tests;

/// <summary>
/// <c>GET /api/entries/{id}/media/{mediaId}</c> — the photo read path, the half of C3 that was
/// missing. Until it existed, a photograph could be uploaded and sealed and then never handed back
/// to anybody: an entry's pictures were visible only in the local store of the phone that took
/// them, so an owner opening the diary on his tablet saw text where the evidence should be.
/// <para>
/// <b>Authenticated bytes, not a presigned GET</b>, same as the report and for a stronger reason.
/// A presigned URL is a credential that outlives the request: for its whole TTL it works for
/// whoever ends up holding it, outside the role gate, outside the tenant filter and outside device
/// revocation. That is an acceptable trade for a one-key write permission the phone is about to
/// use; it is not one for read access to a client's site diary. It is also what makes the tenancy
/// tests below load-bearing rather than ceremonial — this route and the report are the only two
/// places in the product that hand anybody the contents of an object.
/// </para>
/// <para>
/// The valuable tests here are the boundary ones, and they are written against <b>real foreign
/// rows with real bytes in storage</b>, never synthetic ids: a 404 proven against an id that does
/// not exist anywhere proves nothing about tenancy.
/// </para>
/// </summary>
public sealed class MediaDownloadTests(TerenTestApp app) : ApiTestBase(app)
{
    private static string Route(Guid entryId, Guid mediaId) =>
        $"/api/entries/{entryId}/media/{mediaId}";

    // ------------------------------------------------------------------ 200: the bytes

    [Fact]
    public async Task A_verified_photo_is_served_byte_for_byte()
    {
        // The claim the whole increment rests on: what comes out of the endpoint is what went into
        // storage. Not "a PNG" — *the* PNG, because on an evidence product a photograph that is
        // merely similar to the one that was taken is worthless in the dispute it exists for.
        var arranged = await GivenCompletedPhotoAsync();

        var response = await Client.Get(Route(arranged.EntryId, arranged.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        response.Content.Headers.ContentType!.MediaType.ShouldBe("image/png");

        var served = await response.Content.ReadAsByteArrayAsync(Ct);
        served.ShouldBe(arranged.Bytes);
        served.ShouldBe(Storage.GetObject(arranged.Media.ObjectKey));
        Convert.ToHexStringLower(SHA256.HashData(served))
            .ShouldBe(arranged.Media.Sha256.TrimEnd());
    }

    [Fact]
    public async Task The_voice_note_is_served_by_the_same_route()
    {
        // Kind-agnostic on purpose. The archive plays the recording back beside the transcript,
        // and a second endpoint for audio would be a second place to forget the tenant check.
        var audioBytes = Wire.AudioBytes();
        var entryId = Guid.NewGuid();
        var audioId = await GivenCompletedEntryWithAudioAsync(entryId, audioBytes);

        var response = await Client.Get(Route(entryId, audioId));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        response.Content.Headers.ContentType!.MediaType.ShouldBe("audio/ogg");
        (await response.Content.ReadAsByteArrayAsync(Ct)).ShouldBe(audioBytes);
    }

    [Fact]
    public async Task The_response_declares_its_length_and_accepts_ranges()
    {
        var arranged = await GivenCompletedPhotoAsync();

        var response = await Client.Get(Route(arranged.EntryId, arranged.Media.Id));

        response.Content.Headers.ContentLength.ShouldBe(arranged.Bytes.LongLength);

        // Range support is safe here only because the whole object was spooled and verified
        // before anything was served: every byte range is cut from bytes already proven against
        // the record. It is what lets a voice note be scrubbed rather than only played.
        response.Headers.AcceptRanges.ShouldContain("bytes");
    }

    [Fact]
    public async Task A_range_request_returns_that_slice_of_the_verified_bytes()
    {
        var arranged = await GivenCompletedPhotoAsync();

        using var request = new HttpRequestMessage(
            HttpMethod.Get, Route(arranged.EntryId, arranged.Media.Id));
        request.Headers.Range = new RangeHeaderValue(0, 15);

        var response = await Client.SendAsync(request, Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.PartialContent);
        (await response.Content.ReadAsByteArrayAsync(Ct)).ShouldBe(arranged.Bytes[..16]);
    }

    [Fact]
    public async Task The_content_type_is_the_one_sealed_at_declaration_not_the_one_storage_claims()
    {
        // THE MUTATION TARGET for the sniffing hazard: serving `stored.ContentType` instead of the
        // media row's. The object store's idea of a type is metadata attached to bytes; the row is
        // what /complete certified, and it can only be one of the types MediaPolicy admits. Serving
        // storage's claim inline would let whatever is at that key decide how a browser on the
        // app's own origin treats it.
        var arranged = await GivenCompletedPhotoAsync();
        await Storage.PutAsync(arranged.Media.ObjectKey, arranged.Bytes, "text/html", Ct);

        var response = await Client.Get(Route(arranged.EntryId, arranged.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        response.Content.Headers.ContentType!.MediaType.ShouldBe("image/png");
        response.Content.Headers.ContentType.MediaType.ShouldNotBe("text/html");

        // And the browser is told not to second-guess it either.
        response.Headers.GetValues("X-Content-Type-Options").ShouldContain("nosniff");
    }

    [Fact]
    public async Task The_bytes_are_cacheable_privately_and_never_by_a_shared_cache()
    {
        // Sealed media never changes, so `immutable` is honest and the long life is free. What is
        // NOT free is `public`: a shared cache holding a company's site photographs is exactly the
        // leak the presigned URL was rejected for. Vary keeps a re-activated phone's new token
        // from reading the previous token's cache entry.
        var arranged = await GivenCompletedPhotoAsync();

        var response = await Client.Get(Route(arranged.EntryId, arranged.Media.Id));

        var cacheControl = response.Headers.CacheControl.ShouldNotBeNull();
        cacheControl.Private.ShouldBeTrue();
        cacheControl.Public.ShouldBeFalse();
        cacheControl.MaxAge.ShouldNotBeNull().ShouldBeGreaterThan(TimeSpan.FromDays(1));
        response.Headers.CacheControl.ToString().ShouldContain("immutable");
        response.Headers.Vary.ShouldContain("Authorization");
    }

    [Fact]
    public async Task A_conditional_request_is_304_and_object_storage_is_never_touched()
    {
        // The reason the checksum is the ETag rather than something invented: a revalidation can
        // then be answered from the row alone. Without the pre-check the framework would still
        // send 304, but only after the object had been downloaded and hashed — which on an archive
        // scroll is twenty pointless downloads per screen on a small VPS.
        var arranged = await GivenCompletedPhotoAsync();

        var first = await Client.Get(Route(arranged.EntryId, arranged.Media.Id));
        var etag = first.Headers.ETag.ShouldNotBeNull().ToString();
        etag.ShouldContain(arranged.Media.Sha256.TrimEnd());

        var readsAfterFirst = Storage.ReadCallCount;

        using var conditional = new HttpRequestMessage(
            HttpMethod.Get, Route(arranged.EntryId, arranged.Media.Id));
        conditional.Headers.TryAddWithoutValidation("If-None-Match", etag);

        var second = await Client.SendAsync(conditional, Ct);

        second.StatusCode.ShouldBe(HttpStatusCode.NotModified);
        (await second.Content.ReadAsByteArrayAsync(Ct)).ShouldBeEmpty();

        // THE MUTATION TARGET: delete the If-None-Match pre-check and this count goes up.
        Storage.ReadCallCount.ShouldBe(readsAfterFirst);

        // A 304 that dropped the caching directives would make the next read pay again.
        second.Headers.CacheControl.ShouldNotBeNull().Private.ShouldBeTrue();
        second.Headers.ETag.ShouldNotBeNull().ToString().ShouldBe(etag);
    }

    [Fact]
    public async Task A_stale_validator_is_ignored_and_the_bytes_are_served()
    {
        // Anti-vacuity for the test above: the 304 must depend on the tag matching, not on the
        // header merely being present.
        var arranged = await GivenCompletedPhotoAsync();

        using var request = new HttpRequestMessage(
            HttpMethod.Get, Route(arranged.EntryId, arranged.Media.Id));
        request.Headers.TryAddWithoutValidation("If-None-Match", "\"not-this-photograph\"");

        var response = await Client.SendAsync(request, Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.Content.ReadAsByteArrayAsync(Ct)).ShouldBe(arranged.Bytes);
    }

    [Fact]
    public async Task The_disposition_is_inline_and_carries_no_site_and_no_person()
    {
        // A file name is not an object key, but the same rule applies to it here for the same
        // reason: it travels — into a download folder, a screenshot, a support ticket. The report
        // deliberately names the site and the date because a human already holding the report
        // needs to file it; a photograph rendered in the app needs nothing but its own id.
        var arranged = await GivenCompletedPhotoAsync();

        var response = await Client.Get(Route(arranged.EntryId, arranged.Media.Id));

        var disposition = response.Content.Headers.ContentDisposition.ShouldNotBeNull();
        disposition.DispositionType.ShouldBe("inline");
        (disposition.FileNameStar ?? disposition.FileName)!.Trim('"')
            .ShouldBe($"{arranged.Media.Id:D}.png");

        var text = response.Content.Headers.ContentDisposition.ToString();
        text.ShouldNotContain("Vojvode Stepe");
        text.ShouldNotContain("Zoran");
    }

    [Fact]
    public async Task The_file_name_is_readable_by_a_browser_on_another_origin()
    {
        // Content-Disposition is not CORS-safelisted; the PWA runs on a different origin than the
        // API in development and need not share one in production. The default policy already
        // exposes it for the report download — pinned here so a CORS tidy-up cannot quietly take
        // it away from this route too.
        var arranged = await GivenCompletedPhotoAsync();

        using var request = new HttpRequestMessage(
            HttpMethod.Get, Route(arranged.EntryId, arranged.Media.Id));
        request.Headers.Add("Origin", "http://localhost:4200");

        var response = await Client.SendAsync(request, Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        response.Headers.GetValues("Access-Control-Expose-Headers")
            .ShouldContain("Content-Disposition");
    }

    // ------------------------------------------------------------------ 404: tenancy

    [Fact]
    public async Task Another_companys_photo_is_404_and_its_bytes_are_never_served()
    {
        // THE MUTATION TARGET for tenancy, and it is proven against a REAL foreign row with REAL
        // bytes in storage — an id that exists nowhere would make this pass against a broken
        // filter. Drop the tenant filter from the media lookup (swap db.Media for
        // db.Media.IgnoreQueryFilters()) and this turns red with a 200 and another company's
        // photograph in the body.
        var theirs = await GivenAnotherCompanysPhotoAsync();

        var response = await Client.Get(Route(theirs.EntryId, theirs.Media.Id));

        // 404, never 403 and never 409: a photograph that is not yours must be indistinguishable
        // from one that never existed, or a media id becomes an oracle for what is real.
        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        response.StatusCode.ShouldNotBe(HttpStatusCode.Forbidden);
        (await response.TextAsync()).ShouldNotContain("company B private evidence");
    }

    [Fact]
    public async Task A_media_id_of_this_company_read_through_the_wrong_entry_is_404()
    {
        // The mismatched pair. Both ids are real, both belong to the caller's own company, and
        // they do not belong together. THE MUTATION TARGET: drop `m.EntryId == entryId` from the
        // lookup and this turns red — the entry id in the path would become decoration, and any
        // media id in the company would be readable through any entry.
        var mine = await GivenCompletedPhotoAsync();
        var other = await GivenCompletedPhotoAsync(index: 1);

        var response = await Client.Get(Route(other.EntryId, mine.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // Anti-vacuity: each id is perfectly readable through its own entry.
        (await Client.Get(Route(mine.EntryId, mine.Media.Id))).StatusCode
            .ShouldBe(HttpStatusCode.OK);
        (await Client.Get(Route(other.EntryId, other.Media.Id))).StatusCode
            .ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task An_unknown_media_id_on_a_real_entry_is_404()
    {
        var mine = await GivenCompletedPhotoAsync();

        var response = await Client.Get(Route(mine.EntryId, Guid.NewGuid()));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task An_unknown_entry_is_404()
    {
        var response = await Client.Get(Route(Guid.NewGuid(), Guid.NewGuid()));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Foreign_unknown_and_mismatched_are_all_answered_identically()
    {
        // The doctrine as an equality rather than three separate assertions. If any of these
        // answers differs from the others, the route is leaking existence — the body is normalised
        // only for the ids each request itself supplied, which is the one thing that may differ.
        var theirs = await GivenAnotherCompanysPhotoAsync();
        var mine = await GivenCompletedPhotoAsync();
        var other = await GivenCompletedPhotoAsync(index: 1);

        var unknownEntry = Guid.NewGuid();
        var unknownMedia = Guid.NewGuid();

        var foreign = await Client.Get(Route(theirs.EntryId, theirs.Media.Id));
        var unknown = await Client.Get(Route(unknownEntry, unknownMedia));
        var mismatched = await Client.Get(Route(other.EntryId, mine.Media.Id));

        foreign.StatusCode.ShouldBe(unknown.StatusCode);
        mismatched.StatusCode.ShouldBe(unknown.StatusCode);

        Normalise(await foreign.ProblemDetailAsync(), theirs.EntryId, theirs.Media.Id)
            .ShouldBe(Normalise(await unknown.ProblemDetailAsync(), unknownEntry, unknownMedia));
        Normalise(await mismatched.ProblemDetailAsync(), other.EntryId, mine.Media.Id)
            .ShouldBe(Normalise(await unknown.ProblemDetailAsync(), unknownEntry, unknownMedia));
    }

    [Theory]
    [InlineData("not-a-uuid", "b2f4e0f5-0000-4000-8000-000000000001")]
    [InlineData("b2f4e0f5-0000-4000-8000-000000000001", "not-a-uuid")]
    public async Task Ids_that_are_not_uuids_are_400(string entryId, string mediaId)
    {
        var response = await Client.Get($"/api/entries/{entryId}/media/{mediaId}");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_media_id_can_never_choose_the_object_key()
    {
        // The key is composed from the row, never from the path, so a caller cannot walk out of
        // his own prefix. Path traversal in the media id does not even reach storage: it is not a
        // UUID, so it is refused before a query runs — and the request that IS a UUID reads the
        // key the database holds.
        var mine = await GivenCompletedPhotoAsync();
        var readsBefore = Storage.ReadCallCount;

        var traversal = await Client.Get(
            $"/api/entries/{mine.EntryId}/media/..%2F..%2F..%2Freport.pdf");

        traversal.StatusCode.ShouldBeOneOf(HttpStatusCode.BadRequest, HttpStatusCode.NotFound);
        Storage.ReadCallCount.ShouldBe(readsBefore);

        await Client.Get(Route(mine.EntryId, mine.Media.Id));
        Storage.ReadCalls.ShouldContain(mine.Media.ObjectKey);
    }

    [Fact]
    public async Task The_route_is_behind_the_device_token()
    {
        var mine = await GivenCompletedPhotoAsync();

        using var anonymous = App.CreateAnonymousClient();
        var response = await anonymous.Get(Route(mine.EntryId, mine.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    // ------------------------------------------------------------------ the role gate

    [Fact]
    public async Task A_super_admin_cannot_read_a_photograph()
    {
        // Layer 1: RoleFilter refuses before the handler is entered and before an id is parsed, so
        // the 403 leaks nothing. THE MUTATION TARGET: add AppUserRole.SuperAdmin to
        // RoleGates.Evidence and this turns red.
        var mine = await GivenCompletedPhotoAsync();
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.Get(Route(mine.EntryId, mine.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // And it is the same refusal a made-up pair gets, so it says nothing about what exists.
        var nonexistent = await staff.Get(Route(Guid.NewGuid(), Guid.NewGuid()));
        (await RejectionFingerprint.OfAsync(nonexistent))
            .ShouldBe(await RejectionFingerprint.OfAsync(response));
    }

    [Fact]
    public async Task Super_admin_reads_no_media_even_with_the_route_gate_removed()
    {
        // LAYER 2, WRITTEN TO FAIL EVEN IF THE ROUTE GATE IS INTACT-BUT-WRONG — the precedent is
        // RoleGateTests.Super_admin_reads_no_evidence_even_with_the_route_gate_removed. It does not
        // go through the route at all: it installs a super admin's tenant the way BearerAuthFilter
        // does (CompanyId = null, unconditionally) and then issues THE HANDLER'S OWN QUERY. Adding
        // SuperAdmin to RoleGates.Evidence would not make this pass; only breaking the query
        // filters would.
        var mine = await GivenCompletedPhotoAsync();

        await using var db = App.CreateDbContext(companyId: null);

        (await db.Media.CountAsync(Ct)).ShouldBe(0);
        (await db.Media.FirstOrDefaultAsync(
            m => m.Id == mine.Media.Id && m.EntryId == mine.EntryId, Ct)).ShouldBeNull();

        // Anti-vacuity: the row and its object really are there, and only the tenant is hiding it.
        (await db.Media.IgnoreQueryFilters().CountAsync(Ct)).ShouldBeGreaterThan(0);
        Storage.GetObject(mine.Media.ObjectKey).ShouldNotBeNull();
    }

    // ------------------------------------------------------------------ revocation

    [Fact]
    public async Task A_revoked_device_cannot_read_a_photograph_on_its_very_next_request()
    {
        // Written for one mutation: a token-to-principal cache. Two properties are load-bearing
        // and must survive any edit to this test —
        //
        //   * the revocation happens through a DIFFERENT SCOPE than the one that authenticated
        //     (a separate DbContext on the identity model, standing in for the admin surface), so
        //     a cache living in the request scope cannot hide it;
        //   * THERE IS NO await Task.Delay ANYWHERE HERE. The absence of the sleep is the
        //     assertion: a version written with a two-second wait would pass against a
        //     sixty-second cache and prove nothing.
        //
        // It matters more on this route than on any other. Revoking a phone is what a contractor
        // does when one is lost, and the thing on it he minds about is the pictures.
        var mine = await GivenCompletedPhotoAsync();
        (await Client.Get(Route(mine.EntryId, mine.Media.Id))).StatusCode
            .ShouldBe(HttpStatusCode.OK, "the token was good before revocation");

        await using (var identity = App.CreateIdentityDbContext())
        {
            var device = await identity.Devices.SingleAsync(d => d.Id == TestIds.DeviceA, Ct);
            device.RevokedAt = DateTime.UtcNow;
            await identity.SaveChangesAsync(Ct);
        }

        var afterRevocation = await Client.Get(Route(mine.EntryId, mine.Media.Id));

        afterRevocation.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await afterRevocation.Content.ReadAsByteArrayAsync(Ct)).ShouldNotBe(mine.Bytes);
    }

    // ------------------------------------------------------ 409: yours, not servable

    [Fact]
    public async Task A_photo_that_never_arrived_is_409_media_not_ready()
    {
        // The distinction the client needs: "declared, still climbing out of a phone on a bad
        // connection" is worth re-checking; "gone" is worth telling the user about. Answering 404
        // would make the app show a permanent error for a picture that is thirty seconds away.
        var entryId = await GivenEntryAsync();
        var photoId = Guid.NewGuid();
        var bytes = Wire.PhotoBytes();
        await GivenMediaAsync(
            entryId,
            Wire.Photo(photoId, bytes.LongLength, "image/png", Wire.Sha256OfBytes(bytes)));

        var response = await Client.Get(Route(entryId, photoId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("media_not_ready");
    }

    [Fact]
    public async Task A_photo_that_arrived_at_the_wrong_size_is_409_media_not_ready()
    {
        // /complete marked it `failed`: something is at the key, and it is not what was declared.
        // Never served — an uncertified object handed over as this entry's evidence is exactly the
        // thing the whole verification chain exists to prevent.
        var entryId = await GivenEntryAsync();
        var photoId = Guid.NewGuid();
        var bytes = Wire.PhotoBytes();
        await GivenMediaAsync(
            entryId,
            Wire.Photo(photoId, bytes.LongLength, "image/png", Wire.Sha256OfBytes(bytes)));

        await GivenUploadsFinishedAsync(entryId, actualByteSize: bytes.LongLength - 10);
        (await CompleteAsync(entryId)).StatusCode.ShouldBe(HttpStatusCode.OK);

        (await LoadMediumAsync(photoId)).ShouldNotBeNull()
            .UploadStatus.ShouldBe(MediaUploadStatus.Failed);

        var response = await Client.Get(Route(entryId, photoId));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("media_not_ready");
    }

    [Fact]
    public async Task A_photo_whose_object_has_vanished_is_409_media_unavailable()
    {
        // Distinguished from media_not_ready deliberately: no amount of waiting fixes this, so the
        // app must be able to say something true rather than "try again shortly".
        var mine = await GivenCompletedPhotoAsync();
        Storage.RemoveObject(mine.Media.ObjectKey);

        var response = await Client.Get(Route(mine.EntryId, mine.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("media_unavailable");
    }

    [Fact]
    public async Task Bytes_that_do_not_match_the_declared_checksum_are_refused()
    {
        // Raw evidence is never altered, and the corollary is that altered bytes are never served
        // as evidence. THE MUTATION TARGET: pass null instead of media.Sha256 to the verified
        // reader — the substituted image would then be handed over as this entry's photograph,
        // with a 200 and no complaint anywhere.
        var mine = await GivenCompletedPhotoAsync();
        var substitute = Wire.PhotoBytes(index: 7);
        substitute.ShouldNotBe(mine.Bytes);
        Storage.PutObject(mine.Media.ObjectKey, substitute);

        var response = await Client.Get(Route(mine.EntryId, mine.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("media_unavailable");
        (await response.Content.ReadAsByteArrayAsync(Ct)).ShouldNotBe(substitute);
    }

    [Fact]
    public async Task An_object_bigger_than_the_record_declares_is_refused_by_size_not_only_by_hash()
    {
        // The bound exists because a hash cannot be checked until the last byte has been read: how
        // much gets spooled to a temp file would otherwise be decided by whatever sits at the key,
        // so swapping a 300 KB photograph for something enormous fills the disk long before the
        // mismatch is noticed.
        //
        // THE MUTATION TARGET is the maxByteSize argument at the call site, and a status assertion
        // alone would NOT catch its removal — the checksum refuses these bytes either way. So this
        // asserts twice: the answer the caller gets, and, at the seam, WHICH check fired.
        var mine = await GivenCompletedPhotoAsync();
        var declared = mine.Media.ByteSize;

        // A megabyte where a few kilobytes were declared — far enough apart that "how much was
        // actually pulled off the stream" separates a bounded copy from an unbounded one.
        Storage.PutObject(mine.Media.ObjectKey, new byte[1_000_000]);

        var response = await Client.Get(Route(mine.EntryId, mine.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await CodeAsync(response)).ShouldBe("media_unavailable");

        // THE ASSERTION THAT CATCHES THE CALL-SITE MUTATION. The status above is identical with
        // and without the bound, because the checksum refuses these bytes either way — only the
        // byte count says whether the endpoint stopped when the record ran out. One read chunk
        // of slack, because the copy notices at a chunk boundary.
        Storage.BytesReadFor(mine.Media.ObjectKey)
            .ShouldBeLessThan(declared + 81_920 + 1);
        Storage.BytesReadFor(mine.Media.ObjectKey).ShouldBeLessThan(1_000_000);

        // And the reason it is that check and not the checksum, asserted at the seam.
        var refusal = await Should.ThrowAsync<EvidenceIntegrityException>(() =>
            VerifiedObjectReader.OpenVerifiedAsync(
                Storage,
                mine.Media.ObjectKey,
                mine.Media.Sha256.TrimEnd(),
                Ct,
                declared));

        refusal.Kind.ShouldBe(EvidenceIntegrityKind.ChecksumMismatch);
        refusal.Message.ShouldContain("larger than", Case.Insensitive);
    }

    // ------------------------------------------------------------------ 503: storage

    [Fact]
    public async Task Storage_that_is_unreachable_is_503_with_a_retry_after()
    {
        // An outage says nothing about the evidence, so it must not be reported as a problem with
        // the photograph. Same answer the upload path gives, so a client has one rule.
        var mine = await GivenCompletedPhotoAsync();
        Storage.Unreachable = true;

        var response = await Client.Get(Route(mine.EntryId, mine.Media.Id));

        response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
        response.Headers.RetryAfter.ShouldNotBeNull();

        Storage.Unreachable = false;
        (await Client.Get(Route(mine.EntryId, mine.Media.Id))).StatusCode
            .ShouldBe(HttpStatusCode.OK, "the outage left no verdict behind");
    }

    [Fact]
    public async Task Storage_that_answers_too_slowly_is_503_rather_than_a_held_request()
    {
        // The hazard the upload path had to learn about: this read borrows the BULK storage client
        // — a 10 MB photograph would not survive the 5 s phone budget — and that client waits two
        // minutes. Storage answering slowly rather than not at all would otherwise pin an owner's
        // tablet for two minutes per picture. Storage:MediaReadBudget is the ceiling that says
        // otherwise; the fixture pins it to the validator's floor so this costs two seconds.
        var mine = await GivenCompletedPhotoAsync();
        Storage.ReadDelay = TimeSpan.FromSeconds(30);

        var started = DateTime.UtcNow;
        var response = await Client.Get(Route(mine.EntryId, mine.Media.Id));
        var elapsed = DateTime.UtcNow - started;

        response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
        response.Headers.RetryAfter.ShouldNotBeNull();

        // THE MUTATION TARGET: pass `ct` instead of the budget token and this waits thirty
        // seconds instead of two.
        elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(20));

        Storage.ReadDelay = TimeSpan.Zero;
        (await Client.Get(Route(mine.EntryId, mine.Media.Id))).StatusCode
            .ShouldBe(HttpStatusCode.OK, "a slow read left no verdict behind");
    }

    [Fact]
    public void The_shipped_media_read_budget_is_shorter_than_the_bulk_download_timeout()
    {
        // The number that actually deploys, not the one the fixture pins. If the budget were ever
        // configured above DownloadTimeout it would stop bounding anything, and the test above
        // would keep passing because the fixture sets its own.
        var options = new StorageOptions();

        options.MediaReadBudget.ShouldBeLessThan(options.DownloadTimeout);
        options.MediaReadBudget.ShouldBeGreaterThan(options.RequestTimeout);
    }

    // ------------------------------------------------------------------ helpers

    private sealed record ArrangedMedia(Guid EntryId, Media Media, byte[] Bytes);

    /// <summary>
    /// One photograph, declared with its real checksum, its real bytes in storage, and the entry
    /// completed — so the media row is <c>verified</c>, which is the only state this route serves.
    /// </summary>
    private async Task<ArrangedMedia> GivenCompletedPhotoAsync(int index = 0)
    {
        var entryId = await GivenEntryAsync();
        var photoId = Guid.NewGuid();
        var bytes = Wire.PhotoBytes(index);

        await GivenMediaAsync(
            entryId,
            Wire.Photo(photoId, bytes.LongLength, "image/png", Wire.Sha256OfBytes(bytes)));

        var media = (await LoadMediaAsync(entryId)).Single(m => m.Id == photoId);
        Storage.PutObject(media.ObjectKey, bytes);

        var completed = await CompleteAsync(entryId);
        completed.StatusCode.ShouldBe(HttpStatusCode.OK, await completed.TextAsync());

        media = (await LoadMediaAsync(entryId)).Single(m => m.Id == photoId);
        media.UploadStatus.ShouldBe(
            MediaUploadStatus.Verified, "the arrange did not reach verified evidence");

        return new ArrangedMedia(entryId, media, bytes);
    }

    /// <summary>
    /// Company B's entry, company B's media row, and company B's bytes really in storage. Written
    /// straight to the database because the API will never produce another tenant's rows for this
    /// caller — and a tenancy test against an id that exists nowhere proves nothing.
    /// </summary>
    private async Task<ArrangedMedia> GivenAnotherCompanysPhotoAsync()
    {
        var theirEntry = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            theirEntry,
            TestIds.CompanyB,
            TestIds.ProjectB1,
            receivedAt: DateTime.UtcNow));

        var theirMediaId = Guid.NewGuid();
        var bytes = Encoding.ASCII.GetBytes("company B private evidence");
        var media = new Media
        {
            Id = theirMediaId,
            CompanyId = TestIds.CompanyB,
            EntryId = theirEntry,
            Kind = MediaKind.Photo,
            ObjectKey = ObjectKeys.ForMedia(
                TestIds.CompanyB, TestIds.ProjectB1, theirEntry, theirMediaId, "png"),
            ContentType = "image/png",
            ByteSize = bytes.LongLength,
            Sha256 = Wire.Sha256OfBytes(bytes),
            UploadStatus = MediaUploadStatus.Verified,
            CreatedAt = DateTime.UtcNow,
        };

        await InsertMediaAsync(media);
        Storage.PutObject(media.ObjectKey, bytes);

        return new ArrangedMedia(theirEntry, media, bytes);
    }

    private static async Task<string?> CodeAsync(HttpResponseMessage response)
    {
        var body = await response.JsonAsync();
        return body.TryGetProperty("code", out var code) ? code.GetString() : null;
    }

    /// <summary>Blanks the ids a request supplied itself — the one thing two not-found answers may
    /// legitimately differ in.</summary>
    private static string Normalise(string detail, Guid entryId, Guid mediaId) =>
        detail.Replace(entryId.ToString(), "ENTRY").Replace(mediaId.ToString(), "MEDIA");
}
