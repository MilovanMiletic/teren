using System.Net;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Processing;

namespace Teren.Api.Tests;

/// <summary>
/// The archive list: the screen a foreman opens to check that a day did not vanish. Filtering
/// and ordering are the whole feature, and the counts it reports are what the PWA renders
/// without a second round trip.
/// </summary>
public sealed class EntryListTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task Entries_come_back_newest_first()
    {
        var older = await GivenEntryAsync();
        var newer = await GivenEntryAsync();

        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var first = await db.Entries.FindAsync([older], Ct);
            first!.EntryDate = Wire.Today.AddDays(-5);
            await db.SaveChangesAsync(Ct);
        }

        var body = await (await Client.Get("/api/entries")).JsonAsync();

        var ids = body.GetProperty("entries").EnumerateArray().Select(e => e.GetGuid("id")).ToList();
        ids.ShouldBe([newer, older]);
        body.GetProperty("count").GetInt32().ShouldBe(2);
    }

    [Fact]
    public async Task The_list_can_be_filtered_by_project()
    {
        var onA1 = await GivenEntryAsync();
        var onA2 = await GivenEntryAsync(projectId: TestIds.ProjectA2);

        var body = await (await Client.Get($"/api/entries?project_id={TestIds.ProjectA1}")).JsonAsync();

        var ids = body.GetProperty("entries").EnumerateArray().Select(e => e.GetGuid("id")).ToList();
        ids.ShouldBe([onA1]);
        ids.ShouldNotContain(onA2);
    }

    [Fact]
    public async Task The_camel_case_spelling_of_project_id_is_also_accepted()
    {
        // The frontend contract was drafted with projectId; both spellings must reach the filter.
        var onA1 = await GivenEntryAsync();
        await GivenEntryAsync(projectId: TestIds.ProjectA2);

        var body = await (await Client.Get($"/api/entries?projectId={TestIds.ProjectA1}")).JsonAsync();

        body.GetProperty("entries").EnumerateArray().Select(e => e.GetGuid("id")).ShouldBe([onA1]);
    }

    [Fact]
    public async Task The_list_can_be_filtered_by_date_range()
    {
        var inRange = await GivenEntryAsync();
        var outOfRange = await GivenEntryAsync();

        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var entry = await db.Entries.FindAsync([outOfRange], Ct);
            entry!.EntryDate = Wire.Today.AddDays(-30);
            await db.SaveChangesAsync(Ct);
        }

        var from = Wire.Today.AddDays(-2).ToString("yyyy-MM-dd");
        var to = Wire.Today.ToString("yyyy-MM-dd");
        var body = await (await Client.Get($"/api/entries?from={from}&to={to}")).JsonAsync();

        var ids = body.GetProperty("entries").EnumerateArray().Select(e => e.GetGuid("id")).ToList();
        ids.ShouldBe([inRange]);
    }

    [Fact]
    public async Task A_backwards_date_range_is_a_400_not_an_empty_list()
    {
        var from = Wire.Today.ToString("yyyy-MM-dd");
        var to = Wire.Today.AddDays(-5).ToString("yyyy-MM-dd");

        var response = await Client.Get($"/api/entries?from={from}&to={to}");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_date_that_is_not_a_date_is_a_400()
    {
        var response = await Client.Get("/api/entries?from=yesterday");

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(-5, 1)]
    [InlineData(1, 1)]
    [InlineData(9999, 3)]
    public async Task The_limit_is_clamped_rather_than_trusted(int limit, int expected)
    {
        for (var i = 0; i < 3; i++)
        {
            await GivenEntryAsync();
        }

        var body = await (await Client.Get($"/api/entries?limit={limit}")).JsonAsync();

        body.GetProperty("count").GetInt32().ShouldBe(expected);
    }

    [Fact]
    public async Task Each_row_carries_its_photo_count_and_whether_it_has_a_voice_note()
    {
        var withAudio = await GivenEntryAsync();
        await GivenMediaAsync(
            withAudio, Wire.Audio(Guid.NewGuid()),
            Wire.Photo(Guid.NewGuid()), Wire.Photo(Guid.NewGuid()));

        var silent = await GivenEntryAsync();
        await GivenMediaAsync(silent, Wire.Photo(Guid.NewGuid()));

        var rows = (await (await Client.Get("/api/entries")).JsonAsync())
            .GetProperty("entries").EnumerateArray()
            .ToDictionary(e => e.GetGuid("id"));

        rows[withAudio].GetProperty("photo_count").GetInt32().ShouldBe(2);
        rows[withAudio].GetProperty("has_audio").GetBoolean().ShouldBeTrue();
        rows[silent].GetProperty("photo_count").GetInt32().ShouldBe(1);
        rows[silent].GetProperty("has_audio").GetBoolean().ShouldBeFalse();
    }

    [Fact]
    public async Task Each_row_says_why_it_is_stuck_and_what_it_supersedes()
    {
        // Both fields exist on the row to remove a wasted tap. Without the reason, the archive
        // cannot tell a day that is waiting from a day that is stuck, so it offers "Ispravi" on
        // both and one tap lands on a gate that says no. Without the link, a corrected day and its
        // correction are indistinguishable rows. Neither is a new class of data — both are already
        // on the item response, under the same tenant filter.
        var stuck = await GivenEntryAsync();
        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var entry = await db.Entries.FindAsync([stuck], Ct);
            entry!.Status = EntryStatus.NeedsReview;
            entry.FailureReason = ProcessingFailure.Describe(
                ProcessingFailure.TranscriptionEmpty, "the provider found no speech");
            await db.SaveChangesAsync(Ct);
        }

        var correction = Guid.NewGuid();
        var body = Wire.Entry(correction, TestIds.ProjectA1);
        body["supersedes_entry_id"] = stuck.ToString();
        (await Client.PostJson("/api/entries", body)).StatusCode
            .ShouldBe(HttpStatusCode.Accepted);

        var rows = (await (await Client.Get("/api/entries")).JsonAsync())
            .GetProperty("entries").EnumerateArray()
            .ToDictionary(e => e.GetGuid("id"));

        rows[stuck].GetText("failure_reason")
            .ShouldStartWith(ProcessingFailure.TranscriptionEmpty + ":");
        rows[stuck].IsNull("supersedes_entry_id").ShouldBeTrue();

        rows[correction].IsNull("failure_reason").ShouldBeTrue();
        rows[correction].GetGuid("supersedes_entry_id").ShouldBe(stuck);
    }

    [Fact]
    public async Task A_list_row_carries_exactly_these_field_names()
    {
        // Pinned against the JSON and exhaustively, which is F4's lesson written down: a client
        // reading a field the server does not send gets `undefined` and no error, and the founder
        // is told something that is false in both directions. A test that read the C# record could
        // not see a serializer naming change; nor can the PWA's own specs, which test a mock.
        await GivenEntryAsync();

        var row = (await (await Client.Get("/api/entries")).JsonAsync())
            .GetProperty("entries").EnumerateArray().Single();

        row.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal)
            .ShouldBe(
            [
                "created_at",
                "entry_date",
                "failure_reason",
                "has_audio",
                "id",
                "photo_count",
                "project_id",
                "received_at",
                "reported_at",
                "status",
                "supersedes_entry_id",
            ]);
    }

    [Fact]
    public async Task An_entry_that_does_not_exist_is_404_from_the_item_endpoint()
    {
        var response = await Client.Get($"/api/entries/{Guid.NewGuid()}");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task The_item_endpoint_returns_media_in_capture_order()
    {
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        var photoId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(audioId), Wire.Photo(photoId));

        var body = await (await Client.Get($"/api/entries/{entryId}")).JsonAsync();

        body.GetProperty("media").EnumerateArray().Select(m => m.GetGuid("id"))
            .ShouldBe([audioId, photoId], ignoreOrder: true);
    }
}
