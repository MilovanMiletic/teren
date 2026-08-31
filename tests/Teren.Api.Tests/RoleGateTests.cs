using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Tests;

/// <summary>
/// Layer 1 of the four that keep Teren staff away from customer evidence, plus the ordering that
/// makes a 403 safe to have at all (profile-and-identity §6, §8).
/// <para>
/// The four layers, so a reader knows what this file does and does not cover:
/// </para>
/// <list type="number">
/// <item><b>The route gate</b> — here.</item>
/// <item><b>The null tenant</b> — <see cref="Super_admin_reads_no_evidence_even_with_the_route_gate_removed"/>,
/// which is written to fail <em>even if</em> somebody adds SuperAdmin to the gate.</item>
/// <item><b>The model</b> — <see cref="IdentityModelTests"/>.</item>
/// <item><b>The allow-list</b> — <see cref="QueryFilterAllowListTests"/>.</item>
/// </list>
/// </summary>
public sealed class RoleGateTests(TerenTestApp app) : ApiTestBase(app)
{
    // ------------------------------------------------------------ super admin vs evidence

    [Theory]
    [InlineData("/api/projects")]
    [InlineData("/api/entries")]
    public async Task A_super_admin_is_refused_by_every_evidence_route(string route)
    {
        // THE MUTATION TARGET for layer 1. Adding AppUserRole.SuperAdmin to RoleGates.Evidence
        // must turn this red.
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.Get(route);

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_super_admin_cannot_read_one_named_entry_either()
    {
        var entryId = await GivenEntryAsync();
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.Get($"/api/entries/{entryId}");

        // 403, not 404 — and that is not a leak, which is the whole reason the doctrine allows a
        // 403 here at all: the answer did not depend on the id. RoleFilter refused before the id
        // was parsed, so a real id and a nonexistent one produce the same answer, byte for byte.
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var nonexistent = await staff.Get($"/api/entries/{Guid.NewGuid()}");

        (await RejectionFingerprint.OfAsync(nonexistent))
            .ShouldBe(await RejectionFingerprint.OfAsync(response));
    }

    [Fact]
    public async Task Super_admin_reads_no_evidence_even_with_the_route_gate_removed()
    {
        // LAYER 2, AND THIS TEST MUST FAIL EVEN IF THE ROUTE GATE IS INTACT-BUT-WRONG. It does not
        // go through a route at all: it installs a super admin's tenant the way BearerAuthFilter
        // would (CompanyId = null, unconditionally, never from a route value) and then asks the
        // evidence context directly.
        //
        // The mutation it is written for is "set TenantContext.CompanyId from a route value
        // instead of null". With deny-by-default query filters, a null tenant matches nothing —
        // which is why decision 2 (a super admin has no company) was worth taking: the alternative
        // required rewriting the filter expression on every entity.
        await GivenConfirmedEntryAsync(photos: 1);

        await using var db = App.CreateDbContext(companyId: null);

        (await db.Entries.CountAsync(Ct)).ShouldBe(0);
        (await db.Media.CountAsync(Ct)).ShouldBe(0);
        (await db.Reports.CountAsync(Ct)).ShouldBe(0);
        (await db.Projects.CountAsync(Ct)).ShouldBe(0);
        (await db.Companies.CountAsync(Ct)).ShouldBe(0);

        // Anti-vacuity: the rows really are there, and only the tenant is hiding them.
        (await db.Entries.IgnoreQueryFilters().CountAsync(Ct)).ShouldBeGreaterThan(0);
    }

    [Fact]
    public async Task A_super_admin_principal_carries_no_company_at_all()
    {
        // The property layer 2 rests on, asserted where it is decided rather than inferred from a
        // count: a super admin's row cannot even be written with a company
        // (ck_app_user_company_scope), so there is nothing for a tenant filter to match.
        using var staff = await GivenSuperAdminClientAsync();

        var me = await (await staff.Get("/api/me")).JsonAsync();

        me.GetText("role").ShouldBe(AppUserRoleNames.SuperAdmin);
        me.IsNull("company").ShouldBeTrue();
    }

    // ------------------------------------------------------------ worker vs admin surface

    [Theory]
    [InlineData("/api/workers")]
    [InlineData("/api/devices")]
    public async Task A_worker_cannot_reach_the_company_admin_surface(string route)
    {
        // THE MUTATION TARGET for the worker gate. Widening RoleGates.CompanyAdmin to include
        // Worker must turn this red. A foreman who could read the worker list could read every
        // live activation code in the company — that is, activate a phone as any of his mates.
        var response = await Client.Get(route);

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_worker_cannot_issue_himself_an_activation_code()
    {
        var response = await Client.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code");

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await LoadActivationCodesAsync(TestIds.WorkerA)).ShouldBeEmpty();
    }

    [Fact]
    public async Task A_worker_has_no_session_to_end()
    {
        // "There is no sign-out" is a product decision (§10.4), and the shape it takes on the wire
        // is a 403 rather than a route that quietly does nothing.
        var response = await Client.PostNothing("/api/auth/logout");

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_company_admin_cannot_reach_a_platform_route()
    {
        // The platform surface itself lands at D4; the gate it will hang on is proven here on a
        // route that exists today and admits only company admins from the other direction — see
        // A_super_admin_is_refused_by_every_evidence_route. What this asserts is the general
        // property: an admin of one kind is not an admin of the other.
        using var owner = await GivenCompanyAdminClientAsync();

        var me = await (await owner.Get("/api/me")).JsonAsync();

        me.GetText("role").ShouldBe(AppUserRoleNames.CompanyAdmin);
        me.GetProperty("company").GetGuid("id").ShouldBe(TestIds.CompanyA);
    }

    [Fact]
    public async Task A_company_admin_may_still_read_his_own_companys_evidence()
    {
        // Decision 3: a company admin sees everything his company does. The gate excludes Teren
        // staff, not the customer — a test that only proved refusals would pass on a gate that
        // admitted nobody.
        var entryId = await GivenEntryAsync();
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.Get($"/api/entries/{entryId}");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.JsonAsync()).GetGuid("id").ShouldBe(entryId);
    }

    // ------------------------------------------------------------ 401 beats 403 beats 400

    [Fact]
    public async Task An_anonymous_caller_learns_nothing_about_which_roles_a_route_admits()
    {
        // FILTER ORDER, asserted as behaviour rather than as wiring: BearerAuthFilter sits on the
        // /api group and therefore runs outside every RoleFilter. Reverse them and this is a 403,
        // which would tell an unauthenticated stranger that /api/workers exists and is
        // role-gated.
        using var anonymous = App.CreateAnonymousClient();

        var response = await anonymous.Get("/api/workers");

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        response.StatusCode.ShouldNotBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_caller_of_the_wrong_role_learns_nothing_about_the_payload_shape()
    {
        // The other half of the order: RoleFilter sits on the sub-group and therefore runs outside
        // the route's ValidationFilter<T>. Reverse them and a worker posting nonsense to the
        // worker-create route would get a 400 listing the fields it wants — a free map of an admin
        // API he may not call.
        var response = await Client.PostJson("/api/workers", new JsonObject());

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        response.StatusCode.ShouldNotBe(HttpStatusCode.BadRequest);
        (await response.TextAsync()).ShouldNotContain("display_name");
    }

    [Fact]
    public async Task The_403_body_names_no_roles()
    {
        // A body that said "company_admin only" would be a map of the admin surface handed to
        // exactly the caller who is not allowed on it.
        var response = await Client.Get("/api/workers");

        var body = await response.TextAsync();

        body.ShouldNotContain(AppUserRoleNames.CompanyAdmin);
        body.ShouldNotContain(AppUserRoleNames.SuperAdmin);
        body.ShouldNotContain(AppUserRoleNames.Worker);
    }
}
