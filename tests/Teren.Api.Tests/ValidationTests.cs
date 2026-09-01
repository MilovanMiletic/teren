using System.Text.RegularExpressions;
using System.Net;
using System.Text.Json.Nodes;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// Invariant 7: the edges. Everything here is input a phone can produce by accident — a clock
/// that has drifted, a picker that returned nothing, a file the compressor made too large — and
/// the answer has to be a 400 that names the field, not a 500 the outbox will retry forever.
/// </summary>
public sealed class ValidationTests(TerenTestApp app) : ApiTestBase(app)
{
    private async Task<HttpResponseMessage> PostEntryAsync(JsonObject body) =>
        await Client.PostJson("/api/entries", body);

    private static async Task ShouldFailOn(HttpResponseMessage response, string field)
    {
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest, await response.TextAsync());
        (await response.TextAsync()).ShouldContain(field);
    }

    // ------------------------------------------------------------------ entry payload

    [Fact]
    public async Task An_entry_dated_in_the_future_is_rejected()
    {
        var response = await PostEntryAsync(
            Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1, Wire.Today.AddDays(3)));

        await ShouldFailOn(response, "entry_date");
    }

    [Fact]
    public async Task A_days_worth_of_clock_drift_is_tolerated()
    {
        // Phone clocks drift and travel; a day of slack absorbs that without accepting an entry
        // dated next month.
        var response = await PostEntryAsync(
            Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1, Wire.Today.AddDays(1)));

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted, await response.TextAsync());
    }

    [Fact]
    public async Task A_created_at_in_the_future_is_rejected()
    {
        var response = await PostEntryAsync(Wire.Entry(
            Guid.NewGuid(), TestIds.ProjectA1, createdAt: DateTimeOffset.UtcNow.AddDays(3)));

        await ShouldFailOn(response, "created_at");
    }

    [Fact]
    public async Task A_missing_id_is_rejected_by_name()
    {
        var body = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        body.Remove("id");

        await ShouldFailOn(await PostEntryAsync(body), "id");
    }

    [Fact]
    public async Task An_empty_uuid_is_not_an_id()
    {
        await ShouldFailOn(
            await PostEntryAsync(Wire.Entry(Guid.Empty, TestIds.ProjectA1)), "id");
        await ShouldFailOn(
            await PostEntryAsync(Wire.Entry(Guid.NewGuid(), Guid.Empty)), "project_id");
    }

    [Theory]
    [InlineData(91.0, 20.0, "latitude")]
    [InlineData(-91.0, 20.0, "latitude")]
    [InlineData(44.0, 181.0, "longitude")]
    [InlineData(44.0, -181.0, "longitude")]
    public async Task Coordinates_outside_the_world_are_rejected(
        double latitude, double longitude, string field)
    {
        var response = await PostEntryAsync(Wire.Entry(
            Guid.NewGuid(), TestIds.ProjectA1, latitude: latitude, longitude: longitude));

        await ShouldFailOn(response, field);
    }

    [Fact]
    public async Task The_poles_and_the_antimeridian_are_valid_coordinates()
    {
        var response = await PostEntryAsync(Wire.Entry(
            Guid.NewGuid(), TestIds.ProjectA1, latitude: 90, longitude: 180, gpsAccuracyM: 0));

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted, await response.TextAsync());
    }

    [Fact]
    public async Task A_negative_gps_accuracy_is_rejected()
    {
        var response = await PostEntryAsync(Wire.Entry(
            Guid.NewGuid(), TestIds.ProjectA1, gpsAccuracyM: -1));

        await ShouldFailOn(response, "gps_accuracy_m");
    }

    [Fact]
    public async Task Coordinates_survive_the_round_trip_unchanged()
    {
        var entryId = Guid.NewGuid();
        await PostEntryAsync(Wire.Entry(
            entryId, TestIds.ProjectA1, latitude: 44.76931, longitude: 20.47858, gpsAccuracyM: 9.5));

        var entry = await LoadEntryAsync(entryId);
        entry!.Latitude.ShouldBe(44.76931);
        entry.Longitude.ShouldBe(20.47858);
        entry.GpsAccuracyM.ShouldBe(9.5);
    }

    [Fact]
    public async Task A_body_that_is_not_json_is_400_and_not_500()
    {
        // A phone told "server error" retries a payload that can never succeed, forever.
        var response = await Client.PostRaw("/api/entries", "{ not json");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task An_empty_body_is_400()
    {
        var response = await Client.PostRaw("/api/entries", string.Empty);

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task An_entry_for_a_project_that_does_not_exist_is_404()
    {
        var response = await PostEntryAsync(Wire.Entry(Guid.NewGuid(), Guid.NewGuid()));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    // ------------------------------------------------------------------ media payload

    [Theory]
    [InlineData("")]
    [InlineData("not-hex")]
    [InlineData("abc")]
    [InlineData("zz3f5a1c9b2e4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f")] // 64 chars, not hex
    public async Task A_checksum_that_is_not_sha256_is_rejected(string sha256)
    {
        var entryId = await GivenEntryAsync();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Audio(Guid.NewGuid(), sha256: sha256)));

        await ShouldFailOn(response, "sha256");
        (await LoadMediaAsync(entryId)).ShouldBeEmpty();
    }

    [Theory]
    [InlineData("audio", "image/jpeg")]
    [InlineData("photo", "audio/ogg")]
    [InlineData("audio", "audio/flac")]
    [InlineData("photo", "image/heic")]
    [InlineData("photo", "application/octet-stream")]
    public async Task A_content_type_not_accepted_for_the_kind_is_rejected(
        string kind, string contentType)
    {
        var entryId = await GivenEntryAsync();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.File(Guid.NewGuid(), kind, contentType, 1000)));

        await ShouldFailOn(response, "content_type");
        (await LoadMediaAsync(entryId)).ShouldBeEmpty();
    }

    [Theory]
    [InlineData("neither")]
    [InlineData("video")]
    [InlineData("")]
    public async Task A_kind_outside_the_vocabulary_is_rejected(string kind)
    {
        var entryId = await GivenEntryAsync();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.File(Guid.NewGuid(), kind, "image/jpeg", 1000)));

        await ShouldFailOn(response, "kind");
    }

    [Fact]
    public async Task Audio_over_the_ceiling_is_rejected_and_at_the_ceiling_is_not()
    {
        var entryId = await GivenEntryAsync();

        var tooBig = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Audio(Guid.NewGuid(), MediaPolicy.MaxAudioBytes + 1)));
        await ShouldFailOn(tooBig, "byte_size");

        var atLimit = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Audio(Guid.NewGuid(), MediaPolicy.MaxAudioBytes)));
        atLimit.StatusCode.ShouldBe(HttpStatusCode.OK, await atLimit.TextAsync());
    }

    [Fact]
    public async Task Photos_over_the_ceiling_are_rejected_and_at_the_ceiling_are_not()
    {
        var entryId = await GivenEntryAsync();

        var tooBig = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Photo(Guid.NewGuid(), MediaPolicy.MaxPhotoBytes + 1)));
        await ShouldFailOn(tooBig, "byte_size");

        var atLimit = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Photo(Guid.NewGuid(), MediaPolicy.MaxPhotoBytes)));
        atLimit.StatusCode.ShouldBe(HttpStatusCode.OK, await atLimit.TextAsync());
    }

    [Fact]
    public async Task A_photo_may_not_borrow_the_audio_ceiling()
    {
        // The per-kind ceilings must be applied per kind; one shared limit would let a 25 MB
        // "photo" through.
        var entryId = await GivenEntryAsync();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Photo(Guid.NewGuid(), MediaPolicy.MaxAudioBytes)));

        await ShouldFailOn(response, "byte_size");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task A_file_with_no_bytes_is_rejected(long byteSize)
    {
        var entryId = await GivenEntryAsync();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(Wire.Photo(Guid.NewGuid(), byteSize)));

        await ShouldFailOn(response, "byte_size");
    }

    [Fact]
    public async Task An_empty_or_missing_file_list_is_rejected()
    {
        var entryId = await GivenEntryAsync();

        await ShouldFailOn(
            await Client.PostJson($"/api/entries/{entryId}/media", Wire.Files()), "files");
        await ShouldFailOn(
            await Client.PostRaw($"/api/entries/{entryId}/media", "{}"), "files");
    }

    [Fact]
    public async Task The_same_id_twice_in_one_request_is_rejected()
    {
        var entryId = await GivenEntryAsync();
        var mediaId = Guid.NewGuid();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.Photo(mediaId), Wire.Photo(mediaId)));

        await ShouldFailOn(response, "files");
        (await LoadMediaAsync(entryId)).ShouldBeEmpty();
    }

    [Fact]
    public async Task A_capture_time_in_the_future_is_rejected()
    {
        var entryId = await GivenEntryAsync();

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media",
            Wire.Files(Wire.File(
                Guid.NewGuid(), "photo", "image/jpeg", 1000,
                capturedAt: DateTimeOffset.UtcNow.AddDays(3))));

        await ShouldFailOn(response, "captured_at");
    }

    [Fact]
    public async Task Every_problem_in_a_payload_is_reported_in_one_round_trip()
    {
        // A foreman on a site should not discover his mistakes one request at a time.
        var body = Wire.Entry(Guid.Empty, TestIds.ProjectA1, Wire.Today.AddDays(5));
        body["latitude"] = 100.0;

        var response = await PostEntryAsync(body);
        var text = await response.TextAsync();

        text.ShouldContain("id");
        text.ShouldContain("entry_date");
        text.ShouldContain("latitude");
    }

    // ------------------------------------------------------------------ wire format

    [Fact]
    public async Task The_entry_response_is_snake_case_end_to_end()
    {
        // snake_case is the contract the PWA is written against (ARCHITECTURE §6-§8).
        var entryId = await GivenEntryAsync();
        await GivenMediaAsync(entryId, Wire.Audio(Guid.NewGuid()));

        var body = await (await Client.Get($"/api/entries/{entryId}")).JsonAsync();

        foreach (var name in new[]
                 {
                     "project_id", "entry_date", "created_at", "received_at", "confirmed_at",
                     "reported_at", "failure_reason", "gps_accuracy_m", "device_id",
                     "supersedes_entry_id",
                 })
        {
            body.Has(name).ShouldBeTrue(name);
        }

        var media = body.GetProperty("media")[0];
        foreach (var name in new[] { "content_type", "byte_size", "object_key", "upload_status" })
        {
            media.Has(name).ShouldBeTrue(name);
        }

        (await (await Client.Get($"/api/entries/{entryId}")).TextAsync())
            .ShouldNotContain("projectId");
    }

    [Fact]
    public async Task Serbian_characters_are_emitted_as_themselves_not_as_escapes()
    {
        // The content is Serbian; a payload full of š escapes is unreadable in a log line
        // and bigger on the wire for no gain.
        var text = await (await Client.Get("/api/projects")).TextAsync();

        text.ShouldContain("Voždovac");
        text.ShouldNotContain("\\u017E");
    }
}

/// <summary>
/// The wiring guard: every request body a route validates must have a validator the container can
/// actually produce.
/// <para>
/// <b>Written after this exact defect shipped and was caught by six unrelated tests.</b> Validators
/// are registered one by one in <c>Program.cs</c> — there is no assembly scan — so adding
/// <c>AddEndpointFilter&lt;ValidationFilter&lt;T&gt;&gt;()</c> and writing the validator is only two
/// thirds of the job. Miss the third and <see cref="Teren.Api.Validation.ValidationFilter{T}"/>
/// calls <c>GetRequiredService</c> on something nobody registered, which throws
/// <em>before the handler runs</em>: every POST to that route answers <b>500</b>, including the
/// malformed ones that were supposed to answer 400. Nothing about the symptom points at the cause.
/// </para>
/// <para>
/// Source-scanning rather than resolving from the container, following the house precedent
/// (<c>IdentityModelTests</c>' allow-list, the PWA's i18n spec): the coupling being guarded is
/// between two files, so reading both files is the honest check.
/// </para>
/// </summary>
public sealed class ValidatorWiringTests
{
    [Fact]
    public void Every_validated_request_type_has_a_registered_validator()
    {
        var program = File.ReadAllText(Path.Combine(SourceTree.Root(), "Teren.Api", "Program.cs"));

        var validated = SourceTree.Files()
            // Everything except the file that declares the filter, whose own `ValidationFilter<T>`
            // is the generic parameter rather than a request type. Excluding the declaration by
            // path rather than by filtering out short names: `T` today, but a rename to
            // `TBody` would slip straight through a heuristic and leave this guard reporting a
            // type nobody can register.
            .Where(path => !path.EndsWith("ValidationFilter.cs", StringComparison.Ordinal))
            .SelectMany(path => Regex.Matches(
                SourceTree.CodeOf(path), @"ValidationFilter<(\w+)>"))
            .Select(match => match.Groups[1].Value)
            .Distinct()
            .ToList();

        // A guard on the guard: if the scan ever matches nothing, this file would pass forever
        // while proving nothing at all.
        validated.Count.ShouldBeGreaterThan(5);

        var unregistered = validated
            .Where(type => !program.Contains($"IValidator<{type}>", StringComparison.Ordinal))
            .ToList();

        unregistered.ShouldBeEmpty(
            "A route validates a request type whose validator is never registered in Program.cs. "
            + "ValidationFilter resolves it with GetRequiredService, so every request to that "
            + "route — valid or not — answers 500 before the handler runs.\n"
            + string.Join("\n", unregistered));
    }
}
