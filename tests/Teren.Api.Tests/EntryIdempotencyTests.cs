using System.Net;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Storage;

namespace Teren.Api.Tests;

/// <summary>
/// Invariant 1 (PROJECT.md principle 3, ARCHITECTURE §6): the client UUID is the idempotency key.
/// A retry is free — it returns the current state, never a duplicate row and never a conflict —
/// because the phone retries on every flaky site connection and a duplicated entry is a
/// duplicated day of evidence.
/// </summary>
public sealed class EntryIdempotencyTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task First_post_is_accepted_with_202_and_a_location()
    {
        var entryId = Guid.NewGuid();

        var response = await Client.PostJson("/api/entries", Wire.Entry(entryId, TestIds.ProjectA1));

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        response.Headers.Location!.ToString().ShouldBe($"/api/entries/{entryId}");

        var body = await response.JsonAsync();
        body.GetGuid("id").ShouldBe(entryId);
        body.GetGuid("project_id").ShouldBe(TestIds.ProjectA1);
        body.GetText("status").ShouldBe(EntryStatusNames.Received);

        // received_at means "the server holds the complete entry" and is stamped by /complete,
        // not by this call (ARCHITECTURE §6, review F1/F9).
        body.IsNull("received_at").ShouldBeTrue();
    }

    [Fact]
    public async Task Replaying_the_same_post_returns_200_and_creates_no_second_row()
    {
        var entryId = Guid.NewGuid();
        var payload = Wire.Entry(entryId, TestIds.ProjectA1);

        var first = await Client.PostJson("/api/entries", payload);
        var replay = await Client.PostJson("/api/entries", payload);

        first.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        replay.StatusCode.ShouldBe(HttpStatusCode.OK);
        replay.StatusCode.ShouldNotBe(HttpStatusCode.Conflict);

        (await replay.JsonAsync()).GetGuid("id").ShouldBe(entryId);
        (await CountEntriesAsync(entryId)).ShouldBe(1);
    }

    [Fact]
    public async Task Ten_replays_still_leave_exactly_one_entry()
    {
        var entryId = Guid.NewGuid();
        var payload = Wire.Entry(entryId, TestIds.ProjectA1);

        for (var i = 0; i < 10; i++)
        {
            var response = await Client.PostJson("/api/entries", payload);
            ((int)response.StatusCode).ShouldBeLessThan(300);
        }

        (await CountEntriesAsync(entryId)).ShouldBe(1);
    }

    [Fact]
    public async Task A_replay_that_changes_its_mind_does_not_rewrite_the_accepted_entry()
    {
        // The first declaration wins: an entry is evidence, and a retry is not a licence to
        // rewrite what was already accepted.
        var entryId = Guid.NewGuid();
        var yesterday = Wire.Today.AddDays(-1);

        await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA1, yesterday));

        var replay = await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA2, Wire.Today));

        replay.StatusCode.ShouldBe(HttpStatusCode.OK);
        var body = await replay.JsonAsync();
        body.GetGuid("project_id").ShouldBe(TestIds.ProjectA1);
        body.GetText("entry_date").ShouldBe(yesterday.ToString("yyyy-MM-dd"));

        var stored = await LoadEntryAsync(entryId);
        stored!.ProjectId.ShouldBe(TestIds.ProjectA1);
        stored.EntryDate.ShouldBe(yesterday);
    }

    [Fact]
    public async Task A_replay_reports_the_media_the_entry_already_has()
    {
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(audioId));

        var replay = await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA1));

        replay.StatusCode.ShouldBe(HttpStatusCode.OK);
        var media = (await replay.JsonAsync()).MediaById();
        media.Keys.ShouldBe([audioId]);
    }

    [Fact]
    public async Task Losing_the_insert_race_returns_the_winners_state_not_a_conflict()
    {
        // The branch under test is the pk_entry unique-violation catch: two copies of the same
        // request in flight, the phone's retry timer racing its own first attempt. Firing N
        // parallel requests and hoping one loses would be a coin toss; this arms an interceptor
        // that inserts the competing row on another connection immediately before EF's INSERT,
        // so the race happens on every run.
        var entryId = Guid.NewGuid();
        var winnerDate = Wire.Today.AddDays(-2);

        App.RaceInterceptor.ArmOnceBeforeEntryInsert(async () =>
        {
            await using var db = App.CreateDbContext(companyId: null);
            db.Entries.Add(new Entry
            {
                Id = entryId,
                CompanyId = TestIds.CompanyA,
                ProjectId = TestIds.ProjectA2,
                EntryDate = winnerDate,
                Status = EntryStatus.Received,
                CreatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var response = await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA1, Wire.Today));

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var body = await response.JsonAsync();
        body.GetGuid("id").ShouldBe(entryId);
        // The winner is the row that reached the database first, not the one this request carried.
        body.GetGuid("project_id").ShouldBe(TestIds.ProjectA2);
        body.GetText("entry_date").ShouldBe(winnerDate.ToString("yyyy-MM-dd"));

        (await CountEntriesAsync(entryId)).ShouldBe(1);
    }

    [Fact]
    public async Task Losing_the_media_insert_race_is_a_conflict_not_a_not_found()
    {
        // The mirror of the entry race, on the pk_media catch. The handler cannot see the
        // competing row before its insert — the declare read the table and found nothing — so it
        // learns of the collision only from the primary-key violation, and there it has to tell
        // two causes apart: this company's own retry (409, ask for the URLs again) and another
        // company's media id (404, indistinguishable from nothing). Getting that backwards would
        // hand a phone a terminal 404 for an entry the server actually holds, and an outbox that
        // believes a 404 stops retrying — the evidence would be stranded on the handset.
        var entryId = await GivenEntryAsync();
        var otherEntryId = await GivenEntryAsync(projectId: TestIds.ProjectA2);
        var mediaId = Guid.NewGuid();

        // The winner is this company's row, parked on another of its entries on purpose: the
        // object key embeds the entry id, so the keys differ and pk_media is the only constraint
        // violated. Under the same entry the insert would trip ux_media_object_key instead, which
        // is a different catch and would prove nothing about this branch.
        App.RaceInterceptor.ArmOnceBeforeMediaInsert(async () =>
        {
            await using var db = App.CreateDbContext(companyId: null);
            db.Media.Add(new Media
            {
                Id = mediaId,
                CompanyId = TestIds.CompanyA,
                EntryId = otherEntryId,
                Kind = MediaKind.Audio,
                ObjectKey = ObjectKeys.ForMedia(
                    TestIds.CompanyA, TestIds.ProjectA2, otherEntryId, mediaId, "ogg"),
                ContentType = "audio/ogg",
                ByteSize = 120_000,
                Sha256 = Wire.Sha256Of("the winner"),
                UploadStatus = MediaUploadStatus.Pending,
                CreatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(Wire.Audio(mediaId)));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict, await response.TextAsync());
        response.StatusCode.ShouldNotBe(HttpStatusCode.NotFound);
        (await response.ProblemDetailAsync()).ShouldContain("concurrently");

        // The winner stands untouched, and nothing was written under the entry that lost.
        (await LoadMediaAsync(entryId)).ShouldBeEmpty();
        (await LoadMediaAsync(otherEntryId)).ShouldHaveSingleItem().Id.ShouldBe(mediaId);
    }

    [Fact]
    public async Task An_id_that_belongs_to_another_company_is_not_found_not_a_conflict()
    {
        // The other tenant's row is invisible to the query filter, so the handler only learns of
        // it from the primary-key violation. It must answer 404 — identical to "no such entry" —
        // rather than 409, which would confirm to a caller that the id exists somewhere.
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(entryId, TestIds.CompanyB, TestIds.ProjectB1));

        var response = await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA1));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await response.ProblemDetailAsync()).ShouldContain(entryId.ToString());

        // And nothing of company A's was written.
        (await LoadEntryAsync(entryId)).ShouldBeNull();
        (await CountEntriesAsync(entryId)).ShouldBe(1);
    }

    [Fact]
    public async Task Eight_genuinely_concurrent_posts_produce_one_row_and_no_error()
    {
        var entryId = Guid.NewGuid();
        var payload = Wire.Entry(entryId, TestIds.ProjectA1);

        using var client = App.CreateClient();
        var responses = await Task.WhenAll(
            Enumerable.Range(0, 8).Select(_ => client.PostJson("/api/entries", payload)));

        foreach (var response in responses)
        {
            response.StatusCode.ShouldBeOneOf(HttpStatusCode.Accepted, HttpStatusCode.OK);
        }

        responses.Count(r => r.StatusCode == HttpStatusCode.Accepted).ShouldBe(1);
        (await CountEntriesAsync(entryId)).ShouldBe(1);

        foreach (var response in responses)
        {
            response.Dispose();
        }
    }
}
