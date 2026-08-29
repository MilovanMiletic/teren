using Microsoft.EntityFrameworkCore;
using System.Net;
using System.Text.Json.Nodes;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// <c>POST /api/entries/{id}/confirm</c> — the mandatory gate before any report is sent
/// (PROJECT.md principle 5, ARCHITECTURE §7).
/// <para>
/// The invariant these tests exist for is §9.3: <c>raw_transcript</c>, <c>structure</c> and
/// <c>corrected</c> are three separate columns and one must never overwrite another. That triple
/// is the product's eval set and its only record of what the model actually got wrong, so a
/// confirmation that quietly replaced the model's answer with the human's would destroy the
/// signal while looking entirely correct.
/// </para>
/// </summary>
public sealed class ConfirmEntryTests(TerenTestApp app) : ApiTestBase(app)
{
    private static JsonObject Corrected(string note = "ispravljeno") => new()
    {
        ["schema_version"] = 1,
        ["work_done"] = new JsonArray(
            new JsonObject
            {
                ["description"] = "Razvod tople i hladne vode",
                ["location"] = "2. sprat",
                ["quantity"] = new JsonObject { ["value"] = 40, ["unit"] = "m" },
            }),
        ["materials"] = new JsonArray(
            new JsonObject { ["name"] = "PPR cev 25mm", ["delivered"] = true }),
        ["notes"] = note,
    };

    /// <summary>An entry the pipeline has finished with: transcript, structure, awaiting a human.</summary>
    private async Task<Guid> GivenAwaitingConfirmationAsync()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        await ProcessAsync(entryId);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.AwaitingConfirmation);
        return entryId;
    }

    // ------------------------------------------------------------ the happy path

    [Fact]
    public async Task Confirming_stores_the_humans_structure_and_moves_the_entry_to_confirmed()
    {
        var entryId = await GivenAwaitingConfirmationAsync();

        var response = await ConfirmAsync(entryId, Corrected());

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var body = await response.JsonAsync();
        body.GetText("status").ShouldBe(EntryStatusNames.Confirmed);
        body.IsNull("confirmed_at").ShouldBeFalse();

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.Confirmed);
        entry.ConfirmedAt.ShouldNotBeNull();
        entry.Corrected.ShouldNotBeNull();
        entry.Corrected!.ShouldContain("ispravljeno");
    }

    [Fact]
    public async Task The_transcript_and_the_models_structure_survive_confirmation_untouched()
    {
        var entryId = await GivenAwaitingConfirmationAsync();
        var before = await LoadEntryAsync(entryId);

        await ConfirmAsync(entryId, Corrected("sasvim drugačiji tekst"));

        var after = await LoadEntryAsync(entryId);

        // The three columns of the triple, each still holding its own value.
        after!.RawTranscript.ShouldBe(before!.RawTranscript);
        after.Structure.ShouldBe(before.Structure);
        after.Corrected.ShouldNotBe(after.Structure);
        after.Corrected!.ShouldContain("sasvim drugačiji tekst");
    }

    [Fact]
    public async Task The_response_carries_the_transcript_so_the_confirmation_screen_can_show_it()
    {
        var entryId = await GivenAwaitingConfirmationAsync();

        var body = await (await Client.Get($"/api/entries/{entryId}")).JsonAsync();

        body.GetText("raw_transcript").ShouldContain("Danas smo završili");
    }

    // ------------------------------------------------------------ idempotency

    [Fact]
    public async Task Replaying_the_same_confirmation_is_free_and_changes_nothing()
    {
        var entryId = await GivenAwaitingConfirmationAsync();
        var payload = Corrected();

        var first = await ConfirmAsync(entryId, payload);
        first.StatusCode.ShouldBe(HttpStatusCode.OK);
        var confirmedAt = (await LoadEntryAsync(entryId))!.ConfirmedAt;

        var second = await ConfirmAsync(entryId, payload);

        second.StatusCode.ShouldBe(HttpStatusCode.OK);
        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.Confirmed);
        // The moment the human decided, not the moment his phone retried.
        entry.ConfirmedAt.ShouldBe(confirmedAt);
    }

    [Fact]
    public async Task A_second_confirmation_with_different_content_revises_the_entry()
    {
        // Deliberate: immutability begins when the report is sent, not when the first
        // confirmation lands (ARCHITECTURE §6). Until then a person may correct his own answer.
        var entryId = await GivenAwaitingConfirmationAsync();
        await ConfirmAsync(entryId, Corrected("prva verzija"));

        var response = await ConfirmAsync(entryId, Corrected("ispravka"));

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await LoadEntryAsync(entryId))!.Corrected!.ShouldContain("ispravka");
    }

    // ------------------------------------------------------------ immutability

    [Fact]
    public async Task A_reported_entry_rejects_confirmation()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            status: EntryStatus.Reported,
            reportedAt: DateTime.UtcNow,
            receivedAt: DateTime.UtcNow));

        var response = await ConfirmAsync(entryId, Corrected());

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.ProblemDetailAsync()).ShouldContain("supersedes_entry_id");
        (await LoadEntryAsync(entryId))!.Corrected.ShouldBeNull();
    }

    // ------------------------------------------------------------ what may be confirmed

    [Fact]
    public async Task A_needs_review_entry_can_be_confirmed_by_a_human_who_types_the_answer()
    {
        // The typed-shorthand fallback. If this were refused, every entry whose transcription
        // failed would be permanently unreportable — which is the failure mode the whole
        // needs_review state exists to avoid.
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        App.Extractor.Configured = false;
        await ProcessAsync(entryId);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.NeedsReview);

        var response = await ConfirmAsync(entryId, Corrected("ručno uneto"));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var entry = await LoadEntryAsync(entryId);
        entry!.Status.ShouldBe(EntryStatus.Confirmed);
        // The failure is resolved, but the transcript that survived it stays.
        entry.FailureReason.ShouldBeNull();
        entry.RawTranscript.ShouldNotBeNullOrWhiteSpace();
    }

    [Theory]
    [InlineData(EntryStatus.Received)]
    [InlineData(EntryStatus.Processing)]
    public async Task An_entry_the_pipeline_has_not_finished_with_cannot_be_confirmed(
        EntryStatus status)
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            status: status, receivedAt: DateTime.UtcNow));

        var response = await ConfirmAsync(entryId, Corrected());

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await LoadEntryAsync(entryId))!.Corrected.ShouldBeNull();
    }

    // ------------------------------------------------------------ validation and tenancy

    [Fact]
    public async Task A_payload_without_schema_version_is_rejected()
    {
        var entryId = await GivenAwaitingConfirmationAsync();

        var response = await ConfirmAsync(entryId, new JsonObject { ["notes"] = "bez verzije" });

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.TextAsync()).ShouldContain("schema_version");
        (await LoadEntryAsync(entryId))!.Corrected.ShouldBeNull();
    }

    [Fact]
    public async Task A_payload_that_is_not_an_object_is_rejected()
    {
        var entryId = await GivenAwaitingConfirmationAsync();

        var response = await ConfirmAsync(entryId, JsonValue.Create("just a string")!);

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_missing_corrected_field_is_rejected()
    {
        var entryId = await GivenAwaitingConfirmationAsync();

        var response = await Client.PostRaw($"/api/entries/{entryId}/confirm", "{}");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task An_unknown_entry_is_not_found()
    {
        var response = await ConfirmAsync(Guid.NewGuid(), Corrected());

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Another_tenants_entry_is_not_found_rather_than_forbidden()
    {
        // A 403 would confirm the id is real. Same answer as anything that does not exist.
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyB, TestIds.ProjectB1,
            status: EntryStatus.AwaitingConfirmation, receivedAt: DateTime.UtcNow));

        var response = await ConfirmAsync(entryId, Corrected());

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        await using var db = App.CreateDbContext(TestIds.CompanyB);
        (await db.Entries.FirstAsync(e => e.Id == entryId, Ct)).Corrected.ShouldBeNull();
    }

    [Fact]
    public async Task An_anonymous_caller_cannot_confirm()
    {
        var entryId = await GivenAwaitingConfirmationAsync();
        using var anonymous = App.CreateAnonymousClient();

        var response = await anonymous.PostJson(
            $"/api/entries/{entryId}/confirm", new JsonObject { ["corrected"] = Corrected() });

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_malformed_entry_id_is_a_bad_request()
    {
        var response = await Client.PostJson(
            "/api/entries/not-a-uuid/confirm", new JsonObject { ["corrected"] = Corrected() });

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }
}
