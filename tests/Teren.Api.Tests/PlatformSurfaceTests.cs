using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// <c>/api/platform/*</c> — the super admin's surface (D4).
/// <para>
/// The privacy proof lives in <see cref="PlatformPrivacyTests"/>. This file is about the surface
/// doing its job: paging that does not lie, filters that do not silently do nothing, and a
/// suspension that actually reaches the phone it is meant to stop.
/// </para>
/// </summary>
public sealed class PlatformSurfaceTests(TerenTestApp app) : ApiTestBase(app)
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);

    private async Task<Guid> GivenCompanyAsync(HttpClient staff, string name)
    {
        var response = await staff.PostJson(
            "/api/platform/companies", new JsonObject { ["name"] = name });
        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());
        return (await response.JsonAsync()).GetGuid("id");
    }

    // ------------------------------------------------------------------------------ companies

    [Fact]
    public async Task Creating_a_company_records_it_and_says_who_did()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var id = await GivenCompanyAsync(staff, "Elektro Nikolić d.o.o.");

        await using var identity = App.CreateIdentityDbContext();
        var company = await identity.Companies.FirstAsync(c => c.Id == id, Ct);
        company.Name.ShouldBe("Elektro Nikolić d.o.o.");
        company.SuspendedAt.ShouldBeNull();

        var audit = (await LoadAuditAsync())
            .Single(a => a.Action == AdminAuditActions.CompanyCreated && a.SubjectId == id);
        audit.ActorUserId.ShouldBe(TestIds.SuperAdmin);
    }

    [Fact]
    public async Task Creating_a_company_creates_nothing_else()
    {
        // An empty company is a truthful state. Inventing an admin account nobody asked for is how
        // a credential ends up somewhere nobody remembers it exists.
        using var staff = await GivenSuperAdminClientAsync();
        var id = await GivenCompanyAsync(staff, "Prazna firma d.o.o.");

        await using var identity = App.CreateIdentityDbContext();
        (await identity.Users.CountAsync(u => u.CompanyId == id, Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task A_blank_company_name_is_refused_before_a_row_is_written()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson(
            "/api/platform/companies", new JsonObject { ["name"] = "   " });

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    /// <summary>
    /// The heaviest button on this surface, proven where it matters: **on the phone.**
    ///
    /// <para>
    /// Suspension is not a flag on a screen. The authenticator joins <c>company.suspended_at</c>
    /// on every request with no cache and no expiry, so it reaches a device on next contact. A
    /// test that only asserted the column would pass against a suspension that stopped nothing.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Suspending_a_company_stops_its_phones_on_the_next_request()
    {
        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);

        using var staff = await GivenSuperAdminClientAsync();
        var response = await staff.PostNothing($"/api/platform/companies/{TestIds.CompanyA}/suspend");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        // No sleep, and the absence of one is the assertion: a token→principal cache of any
        // duration would make this pass by accident and make revocation "mostly" work in the field.
        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        (await staff.PostNothing($"/api/platform/companies/{TestIds.CompanyA}/resume"))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Suspending_twice_keeps_the_moment_it_actually_happened()
    {
        using var staff = await GivenSuperAdminClientAsync();
        var id = await GivenCompanyAsync(staff, "Dvaput d.o.o.");

        (await staff.PostNothing($"/api/platform/companies/{id}/suspend"))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        // Read the stored value rather than the response text. Postgres keeps `timestamptz` to the
        // microsecond and .NET counts in 100 ns ticks, so the first response — built from the
        // in-memory object — and the row that comes back out of the database are the same instant
        // rendered to different precision. Comparing the strings would fail for a reason that has
        // nothing to do with restamping.
        DateTime? first;
        await using (var identity = App.CreateIdentityDbContext())
        {
            first = (await identity.Companies.FirstAsync(c => c.Id == id, Ct)).SuspendedAt;
        }
        first.ShouldNotBeNull();

        (await staff.PostNothing($"/api/platform/companies/{id}/suspend"))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        await using (var identity = App.CreateIdentityDbContext())
        {
            (await identity.Companies.FirstAsync(c => c.Id == id, Ct)).SuspendedAt.ShouldBe(first);
        }

        // And the second press wrote no audit row: nothing happened, so nothing is recorded.
        (await LoadAuditAsync())
            .Count(a => a.Action == AdminAuditActions.CompanySuspended && a.SubjectId == id)
            .ShouldBe(1);
    }

    [Fact]
    public async Task Suspending_a_company_that_does_not_exist_is_a_plain_404()
    {
        using var staff = await GivenSuperAdminClientAsync();

        (await staff.PostNothing($"/api/platform/companies/{Guid.NewGuid()}/suspend"))
            .StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_company_row_counts_its_people_but_says_nothing_about_their_work()
    {
        await GivenCompanyAdminAsync();
        using var staff = await GivenSuperAdminClientAsync();

        var body = await (await staff.Get("/api/platform/companies")).JsonAsync();
        var mine = body.GetProperty("companies")
            .EnumerateArray()
            .Single(c => c.GetGuid("id") == TestIds.CompanyA);

        mine.GetProperty("user_count").GetInt32().ShouldBeGreaterThan(0);

        // The exclusion, asserted rather than only commented: no count of entries, no project
        // detail, nothing about the diary. This is the assertion that goes red the day somebody
        // adds `entry_count` because a dashboard would look better with it.
        mine.EnumerateObject().Select(p => p.Name).ShouldBe(
            [
                "id", "name", "created_at", "suspended_at", "user_count", "active_user_count",
            ],
            ignoreOrder: true);
    }

    // ---------------------------------------------------------------------------------- users

    [Fact]
    public async Task Users_can_be_filtered_by_role_company_and_status()
    {
        await GivenCompanyAdminAsync();
        using var staff = await GivenSuperAdminClientAsync();

        var workers = await (await staff.Get("/api/platform/users?role=worker")).JsonAsync();
        workers.GetProperty("users").EnumerateArray()
            .ShouldAllBe(u => u.GetText("role") == "worker");

        var mine = await (await staff.Get(
            $"/api/platform/users?company_id={TestIds.CompanyA}")).JsonAsync();
        mine.GetProperty("users").EnumerateArray()
            .ShouldAllBe(u => u.GetGuid("company_id") == TestIds.CompanyA);

        // `pending` is `password_hash IS NULL` — the filter he reaches for when chasing an
        // onboarding that stalled. The demo company admin is seeded without a password.
        var pending = await (await staff.Get(
            "/api/platform/users?status=pending&role=company_admin")).JsonAsync();
        pending.GetProperty("users").EnumerateArray()
            .ShouldAllBe(u => u.GetProperty("password_pending").GetBoolean());
    }

    [Fact]
    public async Task An_unknown_filter_value_is_refused_rather_than_quietly_dropped()
    {
        // A dropped filter answers a different question than the one asked, and on a list this
        // long the caller cannot tell: he reads a full listing as "everybody matched".
        using var staff = await GivenSuperAdminClientAsync();

        (await staff.Get("/api/platform/users?role=owner"))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await staff.Get("/api/platform/users?status=asleep"))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Free_text_search_matches_a_name_an_address_or_a_username()
    {
        using var staff = await GivenSuperAdminClientAsync();

        foreach (var term in new[] { "zoran", "jovanovic" })
        {
            var body = await (await staff.Get($"/api/platform/users?q={term}")).JsonAsync();
            body.GetProperty("users").EnumerateArray().ShouldNotBeEmpty();
        }

        // Wildcards are escaped, so a literal underscore is a literal underscore rather than a
        // one-character wildcard that quietly matches everybody.
        var wild = await (await staff.Get("/api/platform/users?q=%25")).JsonAsync();
        wild.GetProperty("users").EnumerateArray().ShouldBeEmpty();
    }

    [Fact]
    public async Task Disabling_an_account_is_a_soft_stamp_that_the_credential_path_honours()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostNothing($"/api/platform/users/{TestIds.WorkerA}/disable");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // The row survives — an administrative action must never degrade evidence, and this man
        // has entries pointing at him.
        await using (var identity = App.CreateIdentityDbContext())
        {
            (await identity.Users.FirstOrDefaultAsync(u => u.Id == TestIds.WorkerA, Ct))
                .ShouldNotBeNull();
        }

        (await staff.PostNothing($"/api/platform/users/{TestIds.WorkerA}/enable"))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Client.Get("/api/projects")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    // --------------------------------------------------------------------------------- invite

    [Fact]
    public async Task Inviting_an_admin_returns_a_link_that_can_be_read_down_the_phone()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostNothing($"/api/platform/users/{admin.Id}/invite");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        var body = await response.JsonAsync();
        // `invite`, not `reset`: this account has never had a password. Derived from the row, so
        // it cannot be recorded wrongly.
        body.GetText("purpose").ShouldBe("invite");
        body.GetText("token").ShouldStartWith("trn_p_");
        body.GetProperty("superseded").GetInt32().ShouldBe(0);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.CountAsync(
            t => t.UserId == admin.Id && t.ConsumedAt == null && t.SupersededAt == null, Ct))
            .ShouldBe(1);
    }

    /// <summary>
    /// Nothing in the database compels the supersede — there is no <c>ux_password_token_live</c> —
    /// so re-inviting must retire the link it replaces or a founder who re-issues because "the
    /// first one never arrived" leaves it valid for another 48 hours, in whatever inbox it did in
    /// fact arrive in.
    /// </summary>
    [Fact]
    public async Task Re_inviting_retires_the_link_it_replaces_and_says_so()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        using var staff = await GivenSuperAdminClientAsync();

        await staff.PostNothing($"/api/platform/users/{admin.Id}/invite");
        var second = await (await staff.PostNothing(
            $"/api/platform/users/{admin.Id}/invite")).JsonAsync();

        second.GetProperty("superseded").GetInt32().ShouldBe(1);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.CountAsync(
            t => t.UserId == admin.Id && t.ConsumedAt == null && t.SupersededAt == null, Ct))
            .ShouldBe(1);
    }

    [Fact]
    public async Task A_foreman_cannot_be_invited_to_hold_a_password_he_may_not_have()
    {
        // ck_app_user_worker_has_no_password makes it impossible, so a link that could only ever
        // fail a CHECK is worse than an honest refusal. His way back is a fresh activation code.
        using var staff = await GivenSuperAdminClientAsync();

        (await staff.PostNothing($"/api/platform/users/{TestIds.WorkerA}/invite"))
            .StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    // --------------------------------------------------------------------------------- paging

    /// <summary>
    /// <b>The property keyset paging exists for, and offset paging cannot have.</b>
    ///
    /// <para>
    /// A founder scrolls the company list while a customer signs up. With <c>OFFSET</c>, the new
    /// row shifts the window down one: page 2 re-shows the last row of page 1, and one company is
    /// never seen at all. Paging *from a row* is immune, so this asserts the thing that actually
    /// matters — every company appears exactly once across the pages — with a write landing in
    /// between.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Paging_shows_every_company_exactly_once_even_while_rows_are_being_created()
    {
        using var staff = await GivenSuperAdminClientAsync();
        for (var i = 0; i < 5; i++)
        {
            await GivenCompanyAsync(staff, $"Firma {i:D2} d.o.o.");
        }

        var seen = new List<Guid>();
        string? cursor = null;
        var inserted = false;

        do
        {
            var url = "/api/platform/companies?limit=2"
                + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
            var page = await (await staff.Get(url)).JsonAsync();

            foreach (var company in page.GetProperty("companies").EnumerateArray())
            {
                seen.Add(company.GetGuid("id"));
            }

            cursor = page.IsNull("next_cursor") ? null : page.GetText("next_cursor");

            // The insert that breaks offset paging, done once, mid-scroll.
            if (!inserted)
            {
                await GivenCompanyAsync(staff, "Upala usred listanja d.o.o.");
                inserted = true;
            }
        }
        while (cursor is not null);

        seen.ShouldBeUnique();

        // And the five that existed before the scroll began are all there. The one inserted
        // mid-scroll may or may not appear — it sorts above the window — and *that* is the correct
        // behaviour rather than a gap: the page he is on is defined relative to a row, not a count.
        await using var identity = App.CreateIdentityDbContext();
        var before = await identity.Companies
            .Where(c => c.Name.StartsWith("Firma "))
            .Select(c => c.Id)
            .ToListAsync(Ct);

        foreach (var id in before)
        {
            seen.ShouldContain(id);
        }
    }

    [Fact]
    public async Task The_last_page_says_so_rather_than_offering_a_cursor_to_nothing()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var page = await (await staff.Get("/api/platform/companies?limit=200")).JsonAsync();

        page.IsNull("next_cursor").ShouldBeTrue();
    }

    /// <summary>
    /// A cursor that will not decode is a 400, never a silent reset to the first page — which is
    /// how a client loops over page one forever while every request looks perfectly healthy.
    /// </summary>
    [Theory]
    [InlineData("not-base64!!")]
    [InlineData("Zm9v")]
    [InlineData("MTIzOm5vdC1hLWd1aWQ")]
    public async Task A_cursor_this_server_did_not_issue_is_refused(string cursor)
    {
        using var staff = await GivenSuperAdminClientAsync();

        (await staff.Get($"/api/platform/companies?cursor={Uri.EscapeDataString(cursor)}"))
            .StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_page_size_nobody_meant_is_corrected_rather_than_refused()
    {
        using var staff = await GivenSuperAdminClientAsync();

        // Unlike a bad cursor there is no ambiguity about what was meant, and a 400 over `limit=0`
        // teaches a client nothing that simply working would not.
        (await staff.Get("/api/platform/companies?limit=0")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await staff.Get("/api/platform/companies?limit=99999"))
            .StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    // ---------------------------------------------------------------------------------- audit

    [Fact]
    public async Task The_audit_trail_answers_who_did_what_and_can_be_filtered_by_action()
    {
        using var staff = await GivenSuperAdminClientAsync();
        var id = await GivenCompanyAsync(staff, "Revizija d.o.o.");

        var body = await (await staff.Get(
            $"/api/platform/audit?action={AdminAuditActions.CompanyCreated}")).JsonAsync();

        var row = body.GetProperty("actions").EnumerateArray()
            .Single(a => a.GetGuid("subject_id") == id);

        row.GetText("action").ShouldBe(AdminAuditActions.CompanyCreated);
        row.GetText("subject_type").ShouldBe("company");
        row.GetGuid("actor_user_id").ShouldBe(TestIds.SuperAdmin);
        // The actor is named, because "who did this to me" is the question this trail exists for.
        row.GetText("actor_display_name").ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Filtering_the_trail_by_action_is_exact_rather_than_a_search()
    {
        // `worker_disabled` and `user_disabled` are the customer's action and the platform's, and
        // the trail exists to keep them apart. A substring match would fold them into one.
        using var staff = await GivenSuperAdminClientAsync();
        await staff.PostNothing($"/api/platform/users/{TestIds.WorkerA}/disable");

        var body = await (await staff.Get("/api/platform/audit?action=disabled")).JsonAsync();

        body.GetProperty("actions").EnumerateArray().ShouldBeEmpty();
    }

    // ------------------------------------------------------------------- creating an admin

    private static JsonObject NewAdmin(
        string role, string email, Guid? companyId = null, string name = "Nikola Nikolić")
    {
        var body = new JsonObject
        {
            ["role"] = role,
            ["display_name"] = name,
            ["email"] = email,
        };
        if (companyId is Guid id)
        {
            body["company_id"] = id.ToString();
        }
        return body;
    }

    /// <summary>
    /// The thing D4 could not do, and the reason `/platform` had no "add" button: until now an
    /// administrator could only be conjured at a console or by hand in psql.
    /// </summary>
    [Fact]
    public async Task Creating_a_company_admin_returns_him_and_the_link_that_lets_him_in()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson(
            "/api/platform/users",
            NewAdmin(AppUserRoleNames.CompanyAdmin, "nikola@gradnja.rs", TestIds.CompanyA));

        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());

        var body = await response.JsonAsync();
        var user = body.GetProperty("user");
        user.GetText("role").ShouldBe(AppUserRoleNames.CompanyAdmin);
        user.GetGuid("company_id").ShouldBe(TestIds.CompanyA);
        // He has no password and no way to have chosen one yet — that is what the link is for.
        user.GetProperty("password_pending").GetBoolean().ShouldBeTrue();
        user.IsNull("username").ShouldBeTrue();

        var invite = body.GetProperty("invite");
        invite.GetText("purpose").ShouldBe("invite");
        invite.GetText("token").ShouldStartWith("trn_p_");

        // Account and link in one transaction: an admin who exists with no way in is an
        // onboarding the founder would have to notice was unfinished.
        await using var identity = App.CreateIdentityDbContext();
        var created = await identity.Users.FirstAsync(u => u.Email == "nikola@gradnja.rs", Ct);
        (await identity.PasswordTokens.CountAsync(
            t => t.UserId == created.Id && t.ConsumedAt == null && t.SupersededAt == null, Ct))
            .ShouldBe(1);

        (await LoadAuditAsync())
            .ShouldContain(a => a.Action == AdminAuditActions.AdminCreated && a.SubjectId == created.Id);
    }

    [Fact]
    public async Task A_new_member_of_staff_needs_no_company_and_may_not_have_one()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var ok = await staff.PostJson(
            "/api/platform/users", NewAdmin(AppUserRoleNames.SuperAdmin, "kolega@teren.rs"));
        ok.StatusCode.ShouldBe(HttpStatusCode.Created, await ok.TextAsync());
        (await ok.JsonAsync()).GetProperty("user").IsNull("company_id").ShouldBeTrue();

        // ck_app_user_company_scope makes "a super admin inside a tenant" unstorable — layer 2 of
        // the privacy claim, expressed as a constraint. Answered as a sentence, never as a 500.
        var refused = await staff.PostJson(
            "/api/platform/users",
            NewAdmin(AppUserRoleNames.SuperAdmin, "drugi@teren.rs", TestIds.CompanyA));
        refused.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_company_admin_without_a_company_is_refused_before_the_check_constraint_is()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson(
            "/api/platform/users", NewAdmin(AppUserRoleNames.CompanyAdmin, "nicija@gradnja.rs"));

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    /// <summary>
    /// A foreman belongs to a company and is added by that company's own admin, who knows who is on
    /// his sites. Teren staff creating one would be the platform writing into a tenant's surface —
    /// and every entry that man records is then signed with a name the customer never chose.
    /// </summary>
    [Fact]
    public async Task A_foreman_cannot_be_created_from_the_platform()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson(
            "/api/platform/users",
            NewAdmin(AppUserRoleNames.Worker, "poslovodja@gradnja.rs", TestIds.CompanyA));

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task An_address_that_already_has_an_account_is_a_conflict_not_a_second_account()
    {
        var existing = await GivenCompanyAdminAsync();
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson(
            "/api/platform/users",
            NewAdmin(AppUserRoleNames.CompanyAdmin, existing.Email!, TestIds.CompanyA));

        // Email is the login key and globally unique (ux_app_user_email). Two accounts on one
        // address would make "which of these signs in" a coin flip.
        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.Users.CountAsync(u => u.Email == existing.Email, Ct)).ShouldBe(1);
    }

    [Fact]
    public async Task An_unknown_company_is_a_404_and_creates_nobody()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson(
            "/api/platform/users",
            NewAdmin(AppUserRoleNames.CompanyAdmin, "nigde@gradnja.rs", Guid.NewGuid()));

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.Users.AnyAsync(u => u.Email == "nigde@gradnja.rs", Ct)).ShouldBeFalse();
    }

    [Fact]
    public async Task The_new_admin_can_actually_set_a_password_and_sign_in_with_it()
    {
        // The whole point, proven end to end rather than by inspecting rows: create → set password
        // with the returned token → sign in → reach the company surface.
        using var staff = await GivenSuperAdminClientAsync();

        var created = await (await staff.PostJson(
            "/api/platform/users",
            NewAdmin(AppUserRoleNames.CompanyAdmin, "novi@gradnja.rs", TestIds.CompanyA)))
            .JsonAsync();

        var token = created.GetProperty("invite").GetText("token");

        using var anonymous = App.CreateAnonymousClient();
        var set = await anonymous.PostJson(
            "/auth/password",
            new JsonObject { ["token"] = token, ["password"] = "a-passphrase-he-chose-himself" });
        set.StatusCode.ShouldBe(HttpStatusCode.OK, await set.TextAsync());

        using var admin = await SignInAsync("novi@gradnja.rs", "a-passphrase-he-chose-himself");
        (await admin.Get("/api/workers")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }
}
