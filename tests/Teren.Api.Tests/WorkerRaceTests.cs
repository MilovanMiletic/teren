using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// The branches of the worker surface that only run when two writes collide, plus the one
/// collision that needs no concurrency at all.
/// <para>
/// <b>Why this file exists.</b> The D3 review neutered both <c>ux_app_user_email</c> catches (the
/// constraint name typo'd, so a duplicate address 500s) and disabled
/// <c>ActivationCodes.IssueAsync</c>'s retry outright, then ran the whole suite: 788 of 788 still
/// green. Every claim that code makes about itself was unfalsifiable. "Sound by inspection" is
/// exactly what this project's history says not to trust.
/// </para>
/// <para>
/// The races are arranged with <see cref="InsertRaceInterceptor"/> rather than by firing parallel
/// requests, for the reason <see cref="ActivationRaceTests"/> spells out: a test that hoped one of
/// two requests would lose is a coin toss dressed up as a test, and on a fast machine the branch
/// that matters goes unexercised for months.
/// </para>
/// </summary>
public sealed class WorkerRaceTests(TerenTestApp app) : ApiTestBase(app)
{
    // ------------------------------------------------------------ email, no concurrency needed

    [Fact]
    public async Task A_second_worker_on_one_address_is_a_409_the_admin_can_read()
    {
        // No race here at all — an ordinary Tuesday. CreateWorkerAsync has no email pre-check by
        // design (ux_app_user_email is global and partial, so the address may belong to another
        // company's admin and there is nothing this handler could read to see it coming), which
        // means the very first duplicate address in the product's life lands on the catch.
        using var owner = await GivenCompanyAdminClientAsync();

        var first = await owner.PostJson(
            "/api/workers",
            new JsonObject { ["display_name"] = "Ivan Perić", ["email"] = "ivan@primer.test" });
        first.StatusCode.ShouldBe(HttpStatusCode.Created, await first.TextAsync());

        var second = await owner.PostJson(
            "/api/workers",
            new JsonObject
            {
                ["display_name"] = "Marko Marković",
                // Normalised to the same address before it reaches the index.
                ["email"] = "  IVAN@Primer.TEST ",
            });

        second.StatusCode.ShouldBe(HttpStatusCode.Conflict, await second.TextAsync());

        var body = await second.JsonAsync();
        body.GetText("code").ShouldBe("email_taken");
        // Deliberately does not repeat the address back: it is somebody's personal data and may
        // belong to a person in another company entirely.
        (await second.TextAsync()).ShouldNotContain("ivan@primer.test");

        // And the rollback held: no half-created worker, and no code issued to one.
        (await LoadWorkersAsync()).Select(u => u.DisplayName).ShouldNotContain("Marko Marković");
        (await LoadAuditAsync()).Count(a => a.Action == AdminAuditActions.WorkerCreated)
            .ShouldBe(1);
    }

    [Fact]
    public async Task Patching_a_worker_onto_a_taken_address_is_a_409_and_changes_nothing()
    {
        // The PATCH catch is the one with no pre-check of any kind, and the address here belongs
        // to the company ADMIN — a row the worker surface never lists — which is precisely the
        // case a handler-side lookup would miss.
        using var owner = await GivenCompanyAdminClientAsync();

        var response = await owner.PatchJson(
            $"/api/workers/{TestIds.WorkerA}",
            new JsonObject { ["email"] = TestIds.CompanyAdminAEmail });

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict, await response.TextAsync());
        (await response.JsonAsync()).GetText("code").ShouldBe("email_taken");

        // 409, not 500, and the row is untouched — including the audit row the handler had
        // already staged, which went back with the failed SaveChanges.
        (await LoadUserAsync(TestIds.WorkerA))!.Email.ShouldBeNull();
        (await LoadAuditAsync()).ShouldBeEmpty();

        // The context recovered: the very next write on the same surface still works.
        var after = await owner.PatchJson(
            $"/api/workers/{TestIds.WorkerA}",
            new JsonObject { ["email"] = "zoran@primer.test" });

        after.StatusCode.ShouldBe(HttpStatusCode.OK, await after.TextAsync());
        (await LoadUserAsync(TestIds.WorkerA))!.Email.ShouldBe("zoran@primer.test");
    }

    // ------------------------------------------------------------ the username race

    [Fact]
    public async Task A_proposed_username_lost_in_a_race_becomes_the_next_free_one()
    {
        // Two admins adding a "Ivan Perić" in the same second both propose ivan.peric, and the
        // second insert is refused. A PROPOSED name belongs to the server, so it proposes the next
        // one rather than handing the admin a fight he did not pick.
        using var owner = await GivenCompanyAdminClientAsync();

        App.RaceInterceptor.ArmOnceBeforeUserInsert(
            () => GivenCompetingWorkerAsync("ivan.peric"));

        var response = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = "Ivan Perić" });

        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());

        var worker = (await response.JsonAsync()).GetProperty("worker");
        worker.GetText("username").ShouldBe("ivan.peric2");

        // The retry is a whole new attempt, not a resend: exactly one worker row and exactly one
        // audit row came out of it.
        (await LoadWorkersAsync())
            .Count(u => u.CompanyId == TestIds.CompanyA && u.DisplayName == "Ivan Perić")
            .ShouldBe(1);
        (await LoadAuditAsync()).Count(a => a.Action == AdminAuditActions.WorkerCreated)
            .ShouldBe(1);

        // And he is usable: creating a worker you cannot then activate is not a finished action.
        worker.GetProperty("has_live_activation_code").GetBoolean().ShouldBeTrue();
    }

    [Fact]
    public async Task An_explicitly_named_username_lost_in_a_race_is_the_admins_409()
    {
        // The pre-check ran and found nothing — the competitor committed after it — so this 409
        // can only come from the catch. Neuter the constraint name and it becomes a 500.
        using var owner = await GivenCompanyAdminClientAsync();

        App.RaceInterceptor.ArmOnceBeforeUserInsert(
            () => GivenCompetingWorkerAsync("ivan.peric"));

        var response = await owner.PostJson(
            "/api/workers",
            new JsonObject { ["display_name"] = "Ivan Perić", ["username"] = "ivan.peric" });

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict, await response.TextAsync());

        var body = await response.JsonAsync();
        body.GetText("code").ShouldBe("username_taken");
        // A name he typed, so he is told which one and what to do about it.
        body.GetText("detail").ShouldContain("ivan.peric");
        body.GetText("detail").ShouldContain("Leave username out");

        (await LoadWorkersAsync()).Count(u => u.CompanyId == TestIds.CompanyA).ShouldBe(1);
    }

    [Fact]
    public async Task Losing_the_race_twice_on_a_proposed_name_says_try_again_not_pick_another()
    {
        // Two losses means a third caller, which is contention rather than a race, and the handler
        // stops retrying. The admin named nobody, so telling him to "leave username out" would be
        // advice he has already taken — that wording was live before this test existed.
        using var owner = await GivenCompanyAdminClientAsync();

        App.RaceInterceptor.ArmOnceBeforeUserInsert(async () =>
        {
            await GivenCompetingWorkerAsync("ivan.peric");

            // Re-armed from inside the hook, so the server's SECOND proposal loses too.
            App.RaceInterceptor.ArmOnceBeforeUserInsert(
                () => GivenCompetingWorkerAsync("ivan.peric2"));
        });

        var response = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = "Ivan Perić" });

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict, await response.TextAsync());

        var body = await response.JsonAsync();

        // Same problem code — a client branches on one value for "that name is gone" — and a
        // different sentence, because the two arms are different instructions.
        body.GetText("code").ShouldBe("username_taken");
        body.GetText("detail").ShouldNotContain("Leave username out");
        body.GetText("detail").ShouldContain("send the same request again");

        // Nothing was saved, which is what makes "send it again" true.
        (await LoadWorkersAsync()).Count(u => u.CompanyId == TestIds.CompanyA).ShouldBe(1);
        (await LoadAuditAsync()).ShouldBeEmpty();
    }

    // ------------------------------------------------------------ the activation-code race

    [Fact]
    public async Task A_code_whose_insert_loses_the_race_is_retried_rather_than_500ing()
    {
        // The admin taps "issue a new code" while the worker's own /auth/activation-code lands a
        // millisecond earlier: both supersede an empty set, both insert, and
        // ux_activation_code_live refuses the second. Before the retry loop that was an unhandled
        // DbUpdateException — a 500 on the one button that unblocks a man standing on a site.
        using var owner = await GivenCompanyAdminClientAsync();

        App.RaceInterceptor.ArmOnceBeforeActivationCodeInsert(
            () => GivenCompetingCodeAsync(TestIds.WorkerA));

        var response = await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code");

        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());
        var issued = (await response.JsonAsync()).GetText("code");

        var codes = await LoadActivationCodesAsync(TestIds.WorkerA);

        // The competitor's row and this one. ux_activation_code_live means at most one of them can
        // be live, and the retry is what made it this one.
        codes.Count.ShouldBe(2);

        var live = codes
            .Where(c => c.ConsumedAt is null && c.SupersededAt is null)
            .ShouldHaveSingleItem();
        live.CodeDisplay.ShouldBe(issued);

        var loser = codes.Single(c => c.Id != live.Id);
        loser.SupersededAt.ShouldNotBeNull();
        // ck_activation_code_display_cleared refuses to let a dead code keep its plaintext.
        loser.CodeDisplay.ShouldBeNull();

        // The failed attempt's audit row was detached, not resent: one issue, one audit line.
        (await LoadAuditAsync()).Count(a => a.Action == AdminAuditActions.ActivationCodeIssued)
            .ShouldBe(1);
    }

    [Fact]
    public async Task A_first_code_that_loses_inside_the_create_transaction_keeps_the_worker()
    {
        // The savepoint half, and the only way to arrange it. IssueAsync runs inside
        // CreateWorkerAsync's transaction, where the worker exists but is not committed — so the
        // competing row has to be written on the handler's OWN connection to get past
        // fk_activation_code_user. A failed SaveChanges leaves Postgres refusing every further
        // statement in that transaction, so without CreateSavepointAsync/RollbackToSavepointAsync
        // the retry cannot run at all; with a plain rollback instead, the worker insert this
        // transaction already made would go with it.
        using var owner = await GivenCompanyAdminClientAsync();

        App.RaceInterceptor.ArmOnceInsideTransactionBeforeActivationCodeInsert(CompetingCodeSql);

        var response = await owner.PostJson(
            "/api/workers", new JsonObject { ["display_name"] = "Ivan Perić" });

        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());

        var body = await response.JsonAsync();
        var workerId = body.GetProperty("worker").GetGuid("id");

        // The worker survived the savepoint rollback — he was inserted before it was taken.
        var saved = await LoadUserAsync(workerId);
        saved.ShouldNotBeNull();
        saved.DisplayName.ShouldBe("Ivan Perić");

        // And he came out with a usable code. The competing row went back with the savepoint, so
        // this is the only one.
        var code = (await LoadActivationCodesAsync(workerId)).ShouldHaveSingleItem();
        code.ConsumedAt.ShouldBeNull();
        code.SupersededAt.ShouldBeNull();
        code.CodeDisplay.ShouldBe(body.GetProperty("activation_code").GetText("code"));

        var audit = await LoadAuditAsync();
        audit.Count(a => a.Action == AdminAuditActions.WorkerCreated).ShouldBe(1);
        audit.Count(a => a.Action == AdminAuditActions.ActivationCodeIssued).ShouldBe(1);
    }

    // ------------------------------------------------------------ the competitors

    /// <summary>
    /// The other request's worker, committed on its own connection before ours inserts. Company B
    /// on purpose: <c>ux_app_user_username</c> is global, and a race across tenants is the case
    /// the handler cannot see coming.
    /// </summary>
    private async Task GivenCompetingWorkerAsync(string username)
    {
        await using var identity = App.CreateIdentityDbContext();

        identity.Users.Add(new AppUser
        {
            Id = Guid.NewGuid(),
            CompanyId = TestIds.CompanyB,
            Role = AppUserRole.Worker,
            Username = username,
            DisplayName = "Ivan Perić",
            Language = "sr",
            CreatedAt = DateTime.UtcNow,
        });

        await identity.SaveChangesAsync(Ct);
    }

    /// <summary>The other request's activation code for the same worker, committed before ours
    /// inserts — so <c>ux_activation_code_live</c> refuses ours.</summary>
    private async Task GivenCompetingCodeAsync(Guid workerId)
    {
        await using var identity = App.CreateIdentityDbContext();
        var now = DateTime.UtcNow;

        identity.ActivationCodes.Add(new ActivationCode
        {
            Id = Guid.NewGuid(),
            CompanyId = TestIds.CompanyA,
            UserId = workerId,
            CreatedByUserId = workerId,
            CodeHash = CredentialTokens.Hash("competing-code-not-a-secret"),
            CodeDisplay = "AAAA-BBBB",
            CreatedAt = now,
            ExpiresAt = now.AddHours(1),
        });

        await identity.SaveChangesAsync(Ct);
    }

    /// <summary>
    /// The same competitor, written on the handler's own connection and inside its transaction —
    /// the only place from which the not-yet-committed worker row is reachable. Raw SQL rather
    /// than a DbContext because a second context cannot enlist in a transaction it does not own,
    /// and it reads the worker back out of the transaction rather than being told his id, which
    /// the test does not learn until the response comes back.
    /// </summary>
    private static async Task CompetingCodeSql(System.Data.Common.DbCommand command)
    {
        using var competing = command.Connection!.CreateCommand();
        competing.Transaction = command.Transaction;
        competing.CommandText =
            $"""
            INSERT INTO activation_code
                (id, company_id, user_id, created_by_user_id, code_hash, created_at, expires_at)
            SELECT gen_random_uuid(), u.company_id, u.id, u.id, repeat('c', 64),
                   now(), now() + interval '1 hour'
            FROM app_user u
            WHERE u.display_name = 'Ivan Perić'
              AND u.role = '{AppUserRoleNames.Worker}'
            """;

        (await competing.ExecuteNonQueryAsync()).ShouldBe(
            1, "the competing code was not written; the race was not arranged");
    }

    private async Task<List<AppUser>> LoadWorkersAsync()
    {
        await using var identity = App.CreateIdentityDbContext();

        return await identity.Users.AsNoTracking()
            .Where(u => u.Role == AppUserRole.Worker)
            .ToListAsync(Ct);
    }
}
