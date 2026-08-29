using Microsoft.EntityFrameworkCore;
using System.Net;
using System.Text.Json.Nodes;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Storage;

namespace Teren.Api.Tests;

/// <summary>
/// Invariant 3 (ARCHITECTURE §8): what an entry's evidence set may contain, and what a
/// re-declaration means. One voice note, twenty photos, twenty-one media in total. Re-declaring
/// the same id is free — that is how the phone recovers an expired upload URL — but re-declaring
/// it with different content is a conflict, because a media row is an evidence record and it
/// must not become a lie.
/// </summary>
public sealed class MediaDeclarationTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task Declaring_a_voice_note_returns_a_presigned_put_for_exactly_that_object()
    {
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();

        var body = await GivenMediaAsync(entryId, Wire.Audio(audioId));

        body.GetGuid("entry_id").ShouldBe(entryId);
        var upload = body.UploadsById()[audioId];

        upload.GetText("kind").ShouldBe(MediaKindNames.Audio);
        upload.GetText("upload_status").ShouldBe(MediaUploadStatusNames.Pending);
        upload.GetText("method").ShouldBe("PUT");
        upload.GetText("url").ShouldNotBeNullOrWhiteSpace();
        upload.GetProperty("expires_at").GetDateTimeOffset()
            .ShouldBeGreaterThan(DateTimeOffset.UtcNow);
    }

    [Fact]
    public async Task A_presigned_url_lives_for_the_configured_fifteen_minutes()
    {
        // "Some time in the future" is not the invariant — ARCHITECTURE §8 fixes fifteen minutes,
        // and a regression that shortened the TTL to a second would satisfy a `> now` assertion
        // while breaking every phone on a slow connection. The tolerance covers the round trip
        // through the host, not a change of the number.
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        var issuedAt = DateTimeOffset.UtcNow;

        var body = await GivenMediaAsync(entryId, Wire.Audio(audioId));

        body.UploadsById()[audioId].GetProperty("expires_at").GetDateTimeOffset()
            .ShouldBe(issuedAt + TerenTestApp.UploadUrlTtl, TimeSpan.FromSeconds(30));
    }

    [Fact]
    public async Task The_object_key_is_all_ids_and_no_personal_data()
    {
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();

        var body = await GivenMediaAsync(entryId, Wire.Audio(audioId));

        var key = body.UploadsById()[audioId].GetText("object_key");
        key.ShouldBe(ObjectKeys.ForMedia(
            TestIds.CompanyA, TestIds.ProjectA1, entryId, audioId, "ogg"));
        key.ShouldNotContain("Vojvode");
        key.ShouldNotContain("Petrovi");
    }

    [Theory]
    [InlineData("audio/ogg", "ogg")]
    [InlineData("audio/ogg; codecs=opus", "ogg")]
    [InlineData("audio/mp4", "m4a")]
    [InlineData("audio/webm;codecs=opus", "webm")]
    public async Task Audio_content_types_are_normalised_and_map_to_an_extension(
        string declared, string extension)
    {
        // iOS Safari records MP4/AAC and Android OGG/Opus, both with codec parameters; the server
        // normalises rather than rejecting a foreman's only recording (ARCHITECTURE §5).
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();

        await GivenMediaAsync(entryId, Wire.Audio(audioId, contentType: declared));

        var media = await LoadMediumAsync(audioId);
        media!.ObjectKey.ShouldEndWith($".{extension}");
        media.ContentType.ShouldBe(declared.Split(';')[0].Trim());
    }

    [Fact]
    public async Task An_entry_carries_at_most_one_voice_note()
    {
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));

        var second = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(Wire.Audio(Guid.NewGuid())));

        second.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await second.ProblemDetailAsync()).ShouldContain("voice note");
        (await LoadMediaAsync(entryId)).Count(m => m.Kind == MediaKind.Audio).ShouldBe(1);
    }

    [Fact]
    public async Task Two_voice_notes_in_one_request_are_rejected_together()
    {
        var entryId = await GivenEntryAsync();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Audio(Guid.NewGuid()), Wire.Audio(Guid.NewGuid())));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        // Nothing is half-written: the whole declaration is one unit of work.
        (await LoadMediaAsync(entryId)).ShouldBeEmpty();
    }

    [Fact]
    public async Task Twenty_photos_are_allowed_and_the_twenty_first_is_not()
    {
        var entryId = await GivenEntryAsync();
        var photos = Enumerable.Range(0, MediaPolicy.MaxPhotosPerEntry)
            .Select(_ => Wire.Photo(Guid.NewGuid()))
            .ToArray();

        await GivenMediaAsync(entryId, photos);

        var overflow = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(Wire.Photo(Guid.NewGuid())));

        overflow.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await overflow.ProblemDetailAsync()).ShouldContain("20 photos");
        (await LoadMediaAsync(entryId)).Count.ShouldBe(MediaPolicy.MaxPhotosPerEntry);
    }

    [Fact]
    public async Task Twenty_one_media_is_the_whole_evidence_set_and_the_next_one_is_refused()
    {
        var entryId = await GivenEntryAsync();
        JsonObject[] full =
        [
            Wire.Audio(Guid.NewGuid()),
            .. Enumerable.Range(0, MediaPolicy.MaxPhotosPerEntry).Select(_ => Wire.Photo(Guid.NewGuid())),
        ];

        await GivenMediaAsync(entryId, full);
        (await LoadMediaAsync(entryId)).Count.ShouldBe(MediaPolicy.MaxMediaPerEntry);

        foreach (var extra in new[] { Wire.Photo(Guid.NewGuid()), Wire.Audio(Guid.NewGuid()) })
        {
            var response = await Client.PostJson(
                $"/api/entries/{entryId}/media", Wire.Files(extra));
            response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        }

        (await LoadMediaAsync(entryId)).Count.ShouldBe(MediaPolicy.MaxMediaPerEntry);
    }

    [Fact]
    public async Task More_files_than_an_entry_can_hold_are_rejected_before_the_handler()
    {
        var entryId = await GivenEntryAsync();
        var tooMany = Enumerable.Range(0, MediaPolicy.MaxMediaPerEntry + 1)
            .Select(_ => Wire.Photo(Guid.NewGuid()))
            .ToArray();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(tooMany));

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await LoadMediaAsync(entryId)).ShouldBeEmpty();
    }

    [Fact]
    public async Task Re_declaring_the_same_file_is_free_and_mints_a_fresh_url()
    {
        // This is how a client recovers from an expired presigned URL. It must not cost a row,
        // and it must not count against the caps.
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        var file = Wire.Audio(audioId);

        var first = await GivenMediaAsync(entryId, file);
        var second = await GivenMediaAsync(entryId, file);

        second.UploadsById()[audioId].GetText("object_key")
            .ShouldBe(first.UploadsById()[audioId].GetText("object_key"));
        second.UploadsById()[audioId].GetText("url").ShouldNotBeNullOrWhiteSpace();
        (await LoadMediaAsync(entryId)).Count.ShouldBe(1);

        // Still room for the twenty photos: a retry did not consume the entry's quota.
        var photos = Enumerable.Range(0, MediaPolicy.MaxPhotosPerEntry)
            .Select(_ => Wire.Photo(Guid.NewGuid()))
            .ToArray();
        await GivenMediaAsync(entryId, photos);
        (await LoadMediaAsync(entryId)).Count.ShouldBe(MediaPolicy.MaxMediaPerEntry);
    }

    [Theory]
    [InlineData("size")]
    [InlineData("sha256")]
    [InlineData("content_type")]
    [InlineData("kind")]
    public async Task Re_declaring_an_id_with_different_content_is_a_conflict(string changed)
    {
        var entryId = await GivenEntryAsync();
        var mediaId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(mediaId));

        var altered = changed switch
        {
            "size" => Wire.Audio(mediaId, byteSize: 999_999),
            "sha256" => Wire.Audio(mediaId, sha256: Wire.Sha256Of("something else")),
            "content_type" => Wire.Audio(mediaId, contentType: "audio/mp4"),
            _ => Wire.Photo(mediaId, sha256: Wire.Sha256Of(mediaId.ToString())),
        };

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(altered));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.ProblemDetailAsync()).ShouldContain("immutable");

        // The original record is untouched — that is the point of refusing.
        var stored = await LoadMediumAsync(mediaId);
        stored!.Kind.ShouldBe(MediaKind.Audio);
        stored.ByteSize.ShouldBe(120_000);
        stored.ContentType.ShouldBe("audio/ogg");
        stored.Sha256.TrimEnd().ShouldBe(Wire.Sha256Of(mediaId.ToString()));
    }

    [Fact]
    public async Task A_checksum_that_differs_only_in_case_is_the_same_checksum()
    {
        var entryId = await GivenEntryAsync();
        var mediaId = Guid.NewGuid();
        var lower = Wire.Sha256Of(mediaId.ToString());

        await GivenMediaAsync(entryId, Wire.Audio(mediaId, sha256: lower));
        var upper = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Audio(mediaId, sha256: lower.ToUpperInvariant())));

        upper.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await LoadMediumAsync(mediaId))!.Sha256.TrimEnd().ShouldBe(lower);
    }

    [Fact]
    public async Task A_media_id_already_used_by_another_entry_is_a_conflict()
    {
        var firstEntry = await GivenEntryAsync();
        var secondEntry = await GivenEntryAsync();
        var mediaId = Guid.NewGuid();
        await GivenMediaAsync(firstEntry, Wire.Photo(mediaId));

        var response = await Client.PostJson(
            $"/api/entries/{secondEntry}/media", Wire.Files(Wire.Photo(mediaId)));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.ProblemDetailAsync()).ShouldContain("different entry");
        (await LoadMediumAsync(mediaId))!.EntryId.ShouldBe(firstEntry);
    }

    [Fact]
    public async Task Declaring_media_on_an_entry_that_does_not_exist_is_404()
    {
        var response = await Client.PostJson(
            $"/api/entries/{Guid.NewGuid()}/media", Wire.Files(Wire.Audio(Guid.NewGuid())));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task An_entry_past_received_no_longer_accepts_uploads()
    {
        var entryId = await GivenEntryAsync();
        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
            entry.Status = EntryStatus.AwaitingConfirmation;
            await db.SaveChangesAsync(Ct);
        }

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(Wire.Photo(Guid.NewGuid())));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.ProblemDetailAsync()).ShouldContain(EntryStatusNames.AwaitingConfirmation);
    }

    [Fact]
    public async Task Verified_evidence_is_never_handed_a_second_write_permission()
    {
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        var photoId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(audioId), Wire.Photo(photoId));

        // Only the audio actually lands in storage, so only it is verified by /complete.
        var audio = (await LoadMediaAsync(entryId)).Single(m => m.Id == audioId);
        Storage.PutObject(audio.ObjectKey, audio.ByteSize);
        (await CompleteAsync(entryId)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await LoadMediumAsync(audioId))!.UploadStatus.ShouldBe(MediaUploadStatus.Verified);

        var again = await GivenMediaAsync(entryId, Wire.Audio(audioId), Wire.Photo(photoId));

        var verified = again.UploadsById()[audioId];
        verified.GetText("upload_status").ShouldBe(MediaUploadStatusNames.Verified);
        verified.IsNull("url").ShouldBeTrue();
        verified.IsNull("method").ShouldBeTrue();

        // The photo that never arrived still gets a URL — a retry must remain possible.
        again.UploadsById()[photoId].GetText("url").ShouldNotBeNullOrWhiteSpace();
    }
}
