using Microsoft.EntityFrameworkCore;
using System.Net;
using System.Net.Http.Headers;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Storage;

namespace Teren.Api.Tests;

/// <summary>
/// Invariant 2 (ARCHITECTURE §12): deny by default. No token, no request; and anything the
/// caller's company does not own answers 404 — indistinguishable from something that does not
/// exist. There is deliberately no 403 anywhere in this API, because a 403 confirms that an id
/// is real, which is the one thing an enumerator wants to learn.
/// <para>
/// One qualifier, so the doctrine above is not read as more than it is: it is absolute when the
/// caller <em>names</em> an existing resource, and necessarily weaker on the create path, where
/// a fresh id succeeds and a taken one cannot. There, a foreign id is made indistinguishable
/// from the nearest genuine not-found the same route already returns — a foreign project or
/// entry id from one that does not exist, a foreign media id from a missing entry — rather than
/// from an unused id, which no server can offer once the primary key is taken. What the doctrine
/// forbids and these tests enforce is a <em>distinct</em> answer for "exists, but not yours".
/// </para>
/// </summary>
public sealed class TenancyTests(TerenTestApp app) : ApiTestBase(app)
{
    private static readonly string[] ApiRoutes =
    [
        "/api/projects",
        "/api/entries",
    ];

    [Theory]
    [InlineData("/api/projects")]
    [InlineData("/api/entries")]
    public async Task No_authorization_header_is_401(string route)
    {
        using var anonymous = App.CreateAnonymousClient();

        var response = await anonymous.Get(route);

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        response.Headers.WwwAuthenticate.ToString().ShouldContain("Bearer");
    }

    [Fact]
    public async Task Writes_are_401_without_a_token_and_nothing_is_stored()
    {
        using var anonymous = App.CreateAnonymousClient();
        var entryId = Guid.NewGuid();

        var response = await anonymous.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectA1));

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await CountEntriesAsync(entryId)).ShouldBe(0);
    }

    [Theory]
    [InlineData("not-the-token")]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("teren-test-device-token-not-a-secre")]   // one character short
    [InlineData("teren-test-device-token-not-a-secrets")] // one character long
    public async Task A_token_that_is_not_the_token_is_401(string token)
    {
        using var client = App.CreateAnonymousClient();
        client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", $"Bearer {token}");

        var response = await client.Get("/api/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Theory]
    [InlineData("Basic dXNlcjpwYXNz")]
    [InlineData("teren-test-device-token-not-a-secret")] // right token, no scheme
    [InlineData("Bearer")]
    [InlineData("Bearer ")]
    public async Task A_malformed_authorization_header_is_401(string header)
    {
        using var client = App.CreateAnonymousClient();
        client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", header);

        var response = await client.Get("/api/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_scheme_is_matched_case_insensitively()
    {
        using var client = App.CreateAnonymousClient();
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "Authorization", $"bearer {TerenTestApp.DeviceToken}");

        var response = await client.Get("/api/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Projects_lists_only_the_callers_company()
    {
        var response = await Client.Get("/api/projects");

        var ids = (await response.JsonAsync()).EnumerateArray()
            .Select(p => p.GetGuid("id"))
            .ToList();

        ids.ShouldBe([TestIds.ProjectA1, TestIds.ProjectA2], ignoreOrder: true);
        ids.ShouldNotContain(TestIds.ProjectB1);
    }

    [Fact]
    public async Task Creating_an_entry_on_another_companys_project_is_404()
    {
        var entryId = Guid.NewGuid();

        var response = await Client.PostJson(
            "/api/entries", Wire.Entry(entryId, TestIds.ProjectB1));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        response.StatusCode.ShouldNotBe(HttpStatusCode.Forbidden);
        (await CountEntriesAsync(entryId)).ShouldBe(0);
    }

    [Fact]
    public async Task Another_companys_project_is_indistinguishable_from_one_that_does_not_exist()
    {
        var nonexistent = Guid.NewGuid();

        var foreign = await Client.PostJson(
            "/api/entries", Wire.Entry(Guid.NewGuid(), TestIds.ProjectB1));
        var missing = await Client.PostJson(
            "/api/entries", Wire.Entry(Guid.NewGuid(), nonexistent));

        foreign.StatusCode.ShouldBe(missing.StatusCode);

        // The two bodies differ only in the id they echo — no other tell.
        (await foreign.ProblemDetailAsync()).Replace(TestIds.ProjectB1.ToString(), "ID")
            .ShouldBe((await missing.ProblemDetailAsync()).Replace(nonexistent.ToString(), "ID"));
    }

    [Fact]
    public async Task Reading_another_companys_entry_is_404()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(entryId, TestIds.CompanyB, TestIds.ProjectB1));

        var response = await Client.Get($"/api/entries/{entryId}");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        response.StatusCode.ShouldNotBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Declaring_media_on_another_companys_entry_is_404()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(entryId, TestIds.CompanyB, TestIds.ProjectB1));

        var response = await Client.PostJson(
            $"/api/entries/{entryId}/media", Wire.Files(Wire.Audio(Guid.NewGuid())));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await LoadMediaAsync(entryId, TestIds.CompanyB)).ShouldBeEmpty();
    }

    [Fact]
    public async Task Declaring_a_media_id_that_belongs_to_another_company_is_404_not_409()
    {
        // The last existence oracle in the upload path: the tenant filter hides company B's
        // media row, the insert then trips pk_media, and a conflict answer would confirm that a
        // media id the caller does not own is real. Ids are 122-bit random, so the practical
        // risk is small — but "foreign is indistinguishable from nonexistent" is the doctrine,
        // and a low-value leak is still a leak.
        var theirEntry = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(theirEntry, TestIds.CompanyB, TestIds.ProjectB1));

        var theirMediaId = Guid.NewGuid();
        await InsertMediaAsync(new Media
        {
            Id = theirMediaId,
            CompanyId = TestIds.CompanyB,
            EntryId = theirEntry,
            Kind = MediaKind.Audio,
            ObjectKey = ObjectKeys.ForMedia(
                TestIds.CompanyB, TestIds.ProjectB1, theirEntry, theirMediaId, "ogg"),
            ContentType = "audio/ogg",
            ByteSize = 120_000,
            Sha256 = Wire.Sha256Of("theirs"),
            UploadStatus = MediaUploadStatus.Pending,
            CreatedAt = DateTime.UtcNow,
        });

        var mine = await GivenEntryAsync();
        var response = await Client.PostJson(
            $"/api/entries/{mine}/media", Wire.Files(Wire.Audio(theirMediaId)));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        response.StatusCode.ShouldNotBe(HttpStatusCode.Conflict);

        // Nothing was written on this side, and the other tenant's evidence row is untouched.
        (await LoadMediaAsync(mine)).ShouldBeEmpty();
        var theirs = (await LoadMediaAsync(theirEntry, TestIds.CompanyB)).ShouldHaveSingleItem();
        theirs.Id.ShouldBe(theirMediaId);
        theirs.EntryId.ShouldBe(theirEntry);
        theirs.CompanyId.ShouldBe(TestIds.CompanyB);
    }

    [Fact]
    public async Task A_foreign_media_id_answers_exactly_as_a_missing_entry_does()
    {
        // Not merely "also a 404": the same status and the same body, so there is no tell to
        // read. The one thing that legitimately differs is the entry id each echoes.
        var theirEntry = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(theirEntry, TestIds.CompanyB, TestIds.ProjectB1));

        var theirMediaId = Guid.NewGuid();
        await InsertMediaAsync(new Media
        {
            Id = theirMediaId,
            CompanyId = TestIds.CompanyB,
            EntryId = theirEntry,
            Kind = MediaKind.Audio,
            ObjectKey = ObjectKeys.ForMedia(
                TestIds.CompanyB, TestIds.ProjectB1, theirEntry, theirMediaId, "ogg"),
            ContentType = "audio/ogg",
            ByteSize = 120_000,
            Sha256 = Wire.Sha256Of("theirs"),
            UploadStatus = MediaUploadStatus.Pending,
            CreatedAt = DateTime.UtcNow,
        });

        var mine = await GivenEntryAsync();
        var nonexistentEntry = Guid.NewGuid();

        var foreignMedia = await Client.PostJson(
            $"/api/entries/{mine}/media", Wire.Files(Wire.Audio(theirMediaId)));
        var missingEntry = await Client.PostJson(
            $"/api/entries/{nonexistentEntry}/media", Wire.Files(Wire.Audio(Guid.NewGuid())));

        foreignMedia.StatusCode.ShouldBe(missingEntry.StatusCode);
        (await foreignMedia.ProblemDetailAsync()).Replace(mine.ToString(), "ID")
            .ShouldBe((await missingEntry.ProblemDetailAsync())
                .Replace(nonexistentEntry.ToString(), "ID"));
    }

    [Fact]
    public async Task Completing_another_companys_entry_is_404()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(entryId, TestIds.CompanyB, TestIds.ProjectB1));

        var response = await CompleteAsync(entryId);

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // And the other tenant's entry was not stamped as received on the way past.
        await using var db = App.CreateDbContext(TestIds.CompanyB);
        var entry = await db.Entries.AsNoTracking().FirstAsync(e => e.Id == entryId, Ct);
        entry.ReceivedAt.ShouldBeNull();
    }

    [Fact]
    public async Task The_archive_list_never_shows_another_companys_entries()
    {
        var mine = await GivenEntryAsync();
        var theirs = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(theirs, TestIds.CompanyB, TestIds.ProjectB1));

        var response = await Client.Get("/api/entries");

        var ids = (await response.JsonAsync()).GetProperty("entries").EnumerateArray()
            .Select(e => e.GetGuid("id"))
            .ToList();

        ids.ShouldContain(mine);
        ids.ShouldNotContain(theirs);
    }

    [Fact]
    public async Task Filtering_the_archive_by_another_companys_project_is_404()
    {
        var response = await Client.Get($"/api/entries?project_id={TestIds.ProjectB1}");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Every_api_route_sits_behind_the_token()
    {
        // A route added to the /api group without the filter would be the leak this checks for.
        using var anonymous = App.CreateAnonymousClient();

        foreach (var route in ApiRoutes)
        {
            var response = await anonymous.Get(route);
            response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized, route);
        }

        var entryId = Guid.NewGuid();
        (await anonymous.PostJson($"/api/entries/{entryId}/media",
                Wire.Files(Wire.Audio(Guid.NewGuid())))).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
        (await anonymous.PostNothing($"/api/entries/{entryId}/complete")).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
        (await anonymous.Get($"/api/entries/{entryId}")).StatusCode
            .ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_authenticated_entry_is_stamped_with_the_tokens_company_and_device()
    {
        var entryId = await GivenEntryAsync();

        var entry = await LoadEntryAsync(entryId);

        entry!.CompanyId.ShouldBe(TestIds.CompanyA);
        entry.DeviceId.ShouldBe(TestIds.DeviceA);
    }

    [Fact]
    public async Task Media_rows_inherit_the_entrys_company()
    {
        var entryId = await GivenEntryAsync();
        var audioId = Guid.NewGuid();
        await GivenMediaAsync(entryId, Wire.Audio(audioId));

        var media = await LoadMediumAsync(audioId);

        media!.CompanyId.ShouldBe(TestIds.CompanyA);
    }

    [Fact]
    public async Task A_context_with_no_tenant_reads_nothing()
    {
        // Deny-by-default is the property that makes the query filters safe: an unset tenant
        // returns no rows rather than every tenant's rows.
        await GivenEntryAsync();

        await using var db = App.CreateDbContext(companyId: null);

        (await db.Entries.CountAsync(Ct)).ShouldBe(0);
        (await db.Projects.CountAsync(Ct)).ShouldBe(0);
        (await db.Companies.CountAsync(Ct)).ShouldBe(0);
        (await db.Entries.IgnoreQueryFilters().CountAsync(Ct)).ShouldBeGreaterThan(0);
    }

    [Fact]
    public async Task Auth_headers_are_never_echoed_into_the_problem_body()
    {
        using var client = App.CreateAnonymousClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "hunter2");

        var response = await client.Get("/api/projects");

        (await response.TextAsync()).ShouldNotContain("hunter2");
    }
}
