using System.Net;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using System.Text.Json.Nodes;
using Teren.Core.Entities;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// <c>supersedes_entry_id</c> on the way <b>in</b> — the half that did not exist.
///
/// <para>
/// The column, the foreign key, the index and <c>EntryResponse</c> all carried this field; only
/// <c>CreateEntryRequest</c> did not, and <c>System.Text.Json</c> drops an unmapped member without
/// a word. So a "Napravi ispravku" button would have posted a link, got a 202, and written an
/// entry that claimed to be a correction of nothing — and PROJECT.md §5 invariant 2 and
/// ARCHITECTURE §6 both promise the opposite. A correction that cannot name what it corrects is
/// weaker evidence than the paper notebook.
/// </para>
///
/// <para>
/// Three things are being pinned here rather than one: that the link is <em>stored</em>, that the
/// tenant and site checks are the existing 404 doctrine and not a new one, and that idempotency is
/// untouched — a replay can neither add a link, change one, nor drop one.
/// </para>
/// </summary>
public sealed class EntrySupersedesTests(TerenTestApp app) : ApiTestBase(app)
{
    // ------------------------------------------------------------------ the wire shape

    [Fact]
    public async Task A_correction_carries_the_link_it_was_posted_with()
    {
        var original = await GivenEntryAsync();
        var correction = Guid.NewGuid();

        var body = Wire.Entry(correction, TestIds.ProjectA1);
        body["supersedes_entry_id"] = original.ToString();

        var response = await Client.PostJson("/api/entries", body);

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted, await response.TextAsync());
        (await response.JsonAsync()).GetGuid("supersedes_entry_id").ShouldBe(original);

        // And on the poll target, which is what the confirmation screen reads.
        (await (await Client.Get($"/api/entries/{correction}")).JsonAsync())
            .GetGuid("supersedes_entry_id").ShouldBe(original);

        (await LoadEntryAsync(correction))!.SupersedesEntryId.ShouldBe(original);
    }

    [Fact]
    public async Task The_field_is_read_from_the_snake_case_name_the_client_sends()
    {
        // F4's lesson, and it cost the founder two activation codes: a client written against a
        // field name the server does not read gets a success and no field. The name is asserted
        // against the JSON, not against the C# record — a test that reads the type cannot see a
        // serializer naming change, and camelCase must NOT be honoured here, because a phone that
        // spelled it that way would silently write an unlinked correction.
        var original = await GivenEntryAsync();

        var camel = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        camel["supersedesEntryId"] = original.ToString();

        var response = await Client.PostJson("/api/entries", camel);

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted);
        (await response.JsonAsync()).IsNull("supersedes_entry_id").ShouldBeTrue(
            "camelCase is not the wire format; if this ever passes, the naming policy changed "
            + "under the whole API and every other field moved with it");
    }

    // ------------------------------------------------------------------ the original row

    [Fact]
    public async Task Superseding_a_reported_entry_leaves_that_row_untouched()
    {
        // The primary case invariant 2 exists for: the target is sealed and immutable, and the
        // correction is a new row. If the handler ever wrote so much as a flag onto the original,
        // `trg_entry_guard_update` would refuse it and the POST would 500 — so this test is also
        // the proof that the link genuinely lives on the correction alone.
        var original = await GivenConfirmedEntryAsync();
        (await ReportAsync(original)).ShouldBe(ReportOutcome.Sent);

        var before = (await LoadEntryAsync(original))!;
        before.ReportedAt.ShouldNotBeNull("the arrange did not reach a reported entry");

        var body = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        body["supersedes_entry_id"] = original.ToString();

        (await Client.PostJson("/api/entries", body)).StatusCode
            .ShouldBe(HttpStatusCode.Accepted);

        var after = (await LoadEntryAsync(original))!;
        after.ReportedAt.ShouldBe(before.ReportedAt);
        after.Status.ShouldBe(before.Status);
        after.Corrected.ShouldBe(before.Corrected);
        after.SupersedesEntryId.ShouldBeNull("the link points backwards, never forwards");
    }

    [Fact]
    public async Task A_correction_may_supersede_an_entry_that_was_never_reported()
    {
        // THE DECISION, pinned so it is not quietly reversed into a state check.
        //
        // The tempting rule is "the target must be reported", since a reported entry is the only
        // immutable one. It is refused, and the product's own behaviour is the argument: an entry
        // left `confirmed` with `superseded_after_send` has had a report delivered, can never get
        // another (ux_report_entry_id, and there is no sent -> sending), and ARCHITECTURE §6 names
        // a new entry with this very field as its only answer. A reported-only rule would forbid
        // the one correction the server itself asks a person to make.
        //
        // The second argument is the phone's: a 4xx is TERMINAL in the outbox taxonomy, so a
        // refused POST does not bounce, it abandons a day of captured work.
        var received = await GivenEntryAsync();

        var body = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        body["supersedes_entry_id"] = received.ToString();

        var response = await Client.PostJson("/api/entries", body);

        response.StatusCode.ShouldBe(HttpStatusCode.Accepted, await response.TextAsync());
        (await LoadEntryAsync(received))!.Status.ShouldBe(EntryStatus.Received);
    }

    [Fact]
    public async Task A_correction_of_a_correction_is_allowed()
    {
        // Chains are deliberate: a correction can itself be wrong, and forcing every link back to
        // the head would destroy the order in which a day was revised. DemoResetCommand already
        // peels entries leaf-first precisely because a chain can exist.
        var first = await GivenEntryAsync();

        var second = Guid.NewGuid();
        var secondBody = Wire.Entry(second, TestIds.ProjectA1);
        secondBody["supersedes_entry_id"] = first.ToString();
        (await Client.PostJson("/api/entries", secondBody)).StatusCode
            .ShouldBe(HttpStatusCode.Accepted);

        var third = Guid.NewGuid();
        var thirdBody = Wire.Entry(third, TestIds.ProjectA1);
        thirdBody["supersedes_entry_id"] = second.ToString();

        (await Client.PostJson("/api/entries", thirdBody)).StatusCode
            .ShouldBe(HttpStatusCode.Accepted);

        (await LoadEntryAsync(third))!.SupersedesEntryId.ShouldBe(second);
        (await LoadEntryAsync(second))!.SupersedesEntryId.ShouldBe(first);
    }

    // ------------------------------------------------------------------ what is refused

    [Fact]
    public async Task Another_companys_entry_answers_exactly_as_one_that_does_not_exist()
    {
        // The existing doctrine, not a new one (ARCHITECTURE §7): 404 answers existence. The two
        // answers are compared byte for byte, because a difference of one word is an oracle that
        // tells a caller which ids are real in somebody else's company.
        var foreign = Guid.NewGuid();
        await using (var db = App.CreateDbContext(TestIds.CompanyB))
        {
            db.Entries.Add(new Entry
            {
                Id = foreign,
                CompanyId = TestIds.CompanyB,
                ProjectId = TestIds.ProjectB1,
                EntryDate = Wire.Today,
                Status = EntryStatus.Received,
                CreatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync(Ct);
        }

        var real = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        real["supersedes_entry_id"] = foreign.ToString();

        var invented = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        invented["supersedes_entry_id"] = Guid.NewGuid().ToString();

        var inventedId = invented["supersedes_entry_id"]!.GetValue<string>();

        var toForeign = await Client.PostJson("/api/entries", real);
        var toNothing = await Client.PostJson("/api/entries", invented);

        toForeign.StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // The two answers are compared with each caller's OWN id blanked out, and nothing else.
        // Echoing back the id somebody just sent tells him nothing he did not type; anything else
        // that differed between these two bodies would be an oracle telling him which ids are
        // real in another company.
        Blank(await toForeign.TextAsync(), foreign.ToString())
            .ShouldBe(Blank(await toNothing.TextAsync(), inventedId));
    }

    /// <summary>Removes the id the caller itself supplied, and the per-request trace id, from a
    /// problem body — leaving everything a caller could actually learn from the refusal.</summary>
    private static string Blank(string body, string id) =>
        System.Text.RegularExpressions.Regex.Replace(
                body.Replace(id, "<the id the caller sent>", StringComparison.OrdinalIgnoreCase),
                "\"traceId\":\"[^\"]*\"|\"trace_id\":\"[^\"]*\"",
                "\"trace\":\"<per-request>\"");

    [Fact]
    public async Task An_entry_of_another_of_the_companys_own_sites_is_refused()
    {
        // A correction of a day on one site recorded against another is a nonsense link, and its
        // report would go to a different client's inbox. `fk_entry_supersedes_entry` enforces
        // nothing about it — any entry row there is satisfies the constraint — so the endpoint has
        // to. Answered 404 because existence is asked at the granularity the request itself uses:
        // a day of THIS site.
        var onA2 = await GivenEntryAsync(projectId: TestIds.ProjectA2);

        var body = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        body["supersedes_entry_id"] = onA2.ToString();

        var response = await Client.PostJson("/api/entries", body);

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await response.ProblemDetailAsync()).ShouldContain(TestIds.ProjectA1.ToString());
    }

    [Fact]
    public async Task A_refused_link_writes_no_entry_at_all()
    {
        // The 404 is answered before the insert, so a bad link does not leave a half-made record
        // behind that a replay would then find and return as the authoritative state.
        var id = Guid.NewGuid();
        var body = Wire.Entry(id, TestIds.ProjectA1);
        body["supersedes_entry_id"] = Guid.NewGuid().ToString();

        (await Client.PostJson("/api/entries", body)).StatusCode
            .ShouldBe(HttpStatusCode.NotFound);

        (await LoadEntryAsync(id)).ShouldBeNull();
    }

    [Fact]
    public async Task An_entry_cannot_supersede_itself()
    {
        // Not a special case in the handler: the target has to exist before the entry that names
        // it, and this one is being created. It falls out as "no such entry", which is exactly
        // true at the moment the question is asked.
        var id = Guid.NewGuid();
        var body = Wire.Entry(id, TestIds.ProjectA1);
        body["supersedes_entry_id"] = id.ToString();

        (await Client.PostJson("/api/entries", body)).StatusCode
            .ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task An_all_zero_uuid_is_a_400_naming_the_field()
    {
        // Shape, so the validator answers rather than the handler — and the message names the
        // field the way the client spelled it. Guid.Empty can never be an entry id: ids are
        // generated on the phone, and an all-zero one is a client that built a Guid it never
        // filled in.
        var body = Wire.Entry(Guid.NewGuid(), TestIds.ProjectA1);
        body["supersedes_entry_id"] = Guid.Empty.ToString();

        var response = await Client.PostJson("/api/entries", body);

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.TextAsync()).ShouldContain("supersedes_entry_id");
    }

    // ------------------------------------------------------------------ idempotency

    [Fact]
    public async Task A_replay_cannot_add_a_link_the_first_declaration_did_not_have()
    {
        var original = await GivenEntryAsync();
        var entry = await GivenEntryAsync();

        var replay = Wire.Entry(entry, TestIds.ProjectA1);
        replay["supersedes_entry_id"] = original.ToString();

        var response = await Client.PostJson("/api/entries", replay);

        response.StatusCode.ShouldBe(HttpStatusCode.OK, "a replay is never a conflict");
        (await response.JsonAsync()).IsNull("supersedes_entry_id").ShouldBeTrue();
        (await LoadEntryAsync(entry))!.SupersedesEntryId.ShouldBeNull(
            "first declaration wins: an entry is evidence, and a retry is not a licence to "
            + "rewrite what was already accepted");
    }

    [Fact]
    public async Task A_replay_cannot_change_or_drop_a_link()
    {
        var first = await GivenEntryAsync();
        var second = await GivenEntryAsync();

        var correction = Guid.NewGuid();
        var body = Wire.Entry(correction, TestIds.ProjectA1);
        body["supersedes_entry_id"] = first.ToString();
        (await Client.PostJson("/api/entries", body)).StatusCode
            .ShouldBe(HttpStatusCode.Accepted);

        // Re-pointed...
        var repointed = Wire.Entry(correction, TestIds.ProjectA1);
        repointed["supersedes_entry_id"] = second.ToString();
        var changed = await Client.PostJson("/api/entries", repointed);

        changed.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await changed.JsonAsync()).GetGuid("supersedes_entry_id").ShouldBe(first);

        // ...and dropped. A phone whose outbox retries an older copy of the payload must not be
        // able to unlink a correction the server already accepted.
        var dropped = await Client.PostJson(
            "/api/entries", Wire.Entry(correction, TestIds.ProjectA1));

        dropped.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await dropped.JsonAsync()).GetGuid("supersedes_entry_id").ShouldBe(first);
        (await LoadEntryAsync(correction))!.SupersedesEntryId.ShouldBe(first);
    }

    [Fact]
    public async Task A_replay_of_an_entry_whose_target_has_since_been_refused_still_replays()
    {
        // The supersedes check sits AFTER the replay check, which is what makes this true: a
        // replay is answered from what the server holds and the body is not consulted at all. Put
        // the check first and a phone replaying a stale payload would start getting 404s for an
        // entry the server had already accepted — terminal in the outbox taxonomy, so the entry
        // would be abandoned on the phone while existing on the server.
        var entry = await GivenEntryAsync();

        var replay = Wire.Entry(entry, TestIds.ProjectA1);
        replay["supersedes_entry_id"] = Guid.NewGuid().ToString();

        var response = await Client.PostJson("/api/entries", replay);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.JsonAsync()).GetGuid("id").ShouldBe(entry);
    }
}
