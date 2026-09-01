using Microsoft.EntityFrameworkCore;
using System.Net;
using System.Text.Json.Nodes;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// D8 — <c>entry.created_by_user_id</c> and <c>entry.confirmed_by_user_id</c>.
/// <para>
/// This is the column the whole identity model was built to be able to write. A site diary that
/// cannot say <em>who</em> recorded a day is weaker than the notebook it replaces, and until D8
/// every entry in the product was attributed to a company and a phone but to nobody at all.
/// </para>
/// <para>
/// <b>Both values come from the bearer and from nothing else.</b> There is no field in
/// <c>CreateEntryRequest</c> or <c>ConfirmEntryRequest</c> that names a person, and there must
/// never be one: a phone that could name its own author could sign a day's evidence with another
/// man's name, which is the exact property this column exists to establish.
/// </para>
/// </summary>
public sealed class EntryAttributionTests(TerenTestApp app) : ApiTestBase(app)
{
    private static JsonObject Corrected(string note) => new()
    {
        ["schema_version"] = 1,
        ["work_done"] = new JsonArray(
            new JsonObject { ["description"] = "Razvod vode", ["location"] = "2. sprat" }),
        ["notes"] = note,
    };

    private async Task<Guid> GivenAwaitingConfirmationAsync()
    {
        var entryId = Guid.NewGuid();
        await GivenCompletedEntryWithAudioAsync(entryId);
        await ProcessAsync(entryId);
        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.AwaitingConfirmation);
        return entryId;
    }

    // ------------------------------------------------------------------- who recorded it

    [Fact]
    public async Task A_new_entry_is_stamped_with_the_worker_whose_credential_recorded_it()
    {
        var entryId = await GivenEntryAsync();

        var entry = await LoadEntryAsync(entryId);

        entry!.CreatedByUserId.ShouldBe(TestIds.WorkerA);
        // Alongside the device, not instead of it: a phone can be handed on, a username cannot.
        entry.DeviceId.ShouldBe(TestIds.DeviceA);
    }

    [Fact]
    public async Task Creating_an_entry_leaves_who_confirmed_it_unanswered()
    {
        // Recording and approving are separate acts, and the second has not happened yet. A
        // create that filled both columns would make every unconfirmed entry look approved to
        // anything that later reads this column.
        var entryId = await GivenEntryAsync();

        (await LoadEntryAsync(entryId))!.ConfirmedByUserId.ShouldBeNull();
    }

    // ------------------------------------------------------------------- who approved it

    [Fact]
    public async Task Confirming_stamps_the_person_who_approved_what_the_report_will_say()
    {
        var entryId = await GivenAwaitingConfirmationAsync();

        var response = await ConfirmAsync(entryId, Corrected("prvo"));
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var entry = await LoadEntryAsync(entryId);
        entry!.ConfirmedByUserId.ShouldBe(TestIds.WorkerA);
        // And the author is untouched by the approval — two acts, two columns.
        entry.CreatedByUserId.ShouldBe(TestIds.WorkerA);
    }

    /// <summary>
    /// A revision re-stamps, and a second person's revision takes the column.
    /// <para>
    /// <b>The property being pinned is "whoever approved the version that is about to be sent".</b>
    /// A report is built from the entry as it stands when the report goes out, so a column that
    /// kept the first approver would name a man for content he never saw.
    /// </para>
    /// <para>
    /// This test also happens to record that a <c>company_admin</c> may confirm at all — he is in
    /// <c>RoleGates.Evidence</c> today. <c>plans/profile-and-identity.md</c> §14.1 asks the founder
    /// whether he should be, with a recommendation of worker-only. **If that is decided worker-only,
    /// this test changes with the policy** — which is the right place for the decision to surface.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_revision_moves_the_stamp_to_whoever_approved_the_version_being_sent()
    {
        var entryId = await GivenAwaitingConfirmationAsync();
        await ConfirmAsync(entryId, Corrected("poslovođa"));
        (await LoadEntryAsync(entryId))!.ConfirmedByUserId.ShouldBe(TestIds.WorkerA);

        using var admin = await GivenCompanyAdminClientAsync();
        var response = await admin.PostJson(
            $"/api/entries/{entryId}/confirm",
            new JsonObject { ["corrected"] = Corrected("vlasnik ispravio") });

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var entry = await LoadEntryAsync(entryId);
        entry!.ConfirmedByUserId.ShouldBe(TestIds.CompanyAdminA);
        // The *author* is still the man who was on site. An approval is not a recording, and
        // nothing an admin does at a desk may rewrite who stood on the scaffold.
        entry.CreatedByUserId.ShouldBe(TestIds.WorkerA);
    }

    /// <summary>
    /// A replay writes nothing — the same rule <c>confirmed_at</c> already lives by, and for the
    /// same reason: these columns record the moment and the person that <em>decided</em>, not
    /// whichever retry timer fired last. A phone that lost its answer on a tunnel and resent it
    /// must not re-attribute the decision.
    /// </summary>
    [Fact]
    public async Task A_replayed_confirmation_does_not_restamp_who_approved_it()
    {
        var entryId = await GivenAwaitingConfirmationAsync();
        await ConfirmAsync(entryId, Corrected("isto"));

        var first = await LoadEntryAsync(entryId);
        var stampedAt = first!.ConfirmedAt;

        // Byte-identical content from a different person: the replay branch returns before it
        // writes, so his id must not appear. Without that early return this is how an entry
        // quietly changes hands — no content changed, and the record of who approved it did.
        using var admin = await GivenCompanyAdminClientAsync();
        var response = await admin.PostJson(
            $"/api/entries/{entryId}/confirm",
            new JsonObject { ["corrected"] = Corrected("isto") });

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var entry = await LoadEntryAsync(entryId);
        entry!.ConfirmedByUserId.ShouldBe(TestIds.WorkerA);
        entry.ConfirmedAt.ShouldBe(stampedAt);
    }

    // ------------------------------------------------------------------- no backfill

    /// <summary>
    /// The columns are nullable and stay null on rows that predate them, deliberately.
    /// <para>
    /// Standing the immutability guard down to write a plausible author onto sealed evidence would
    /// be inventing provenance, which is the one thing attribution exists to prevent. Null means
    /// "recorded before Teren tracked people" and that is the honest answer. The migration adds
    /// the columns as DDL with no default, so no reported row is rewritten and no row trigger
    /// fires — this asserts the shape that makes that possible.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Confirming_an_entry_that_predates_attribution_does_not_invent_an_author()
    {
        var entryId = await GivenAwaitingConfirmationAsync();

        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            // A row as it stood before D8: accepted, attributed to a company and a phone, and to
            // nobody. Written straight to the model, because no route can produce one any more.
            var before = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
            before.CreatedByUserId = null;
            await db.SaveChangesAsync(Ct);
        }

        var response = await ConfirmAsync(entryId, Corrected("potvrđeno"));
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var entry = await LoadEntryAsync(entryId);
        // The approver is now known and the author never will be. Filling the author in from the
        // confirmer would be a guess, and a guess written into an evidence column reads exactly
        // like a fact to everything downstream of it.
        entry!.ConfirmedByUserId.ShouldBe(TestIds.WorkerA);
        entry.CreatedByUserId.ShouldBeNull();
    }
}
