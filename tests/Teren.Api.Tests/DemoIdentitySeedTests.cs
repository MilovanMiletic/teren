using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Identity;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// The compatibility hinge, and the reason D1 needed no dual-credential code at all
/// (profile-and-identity §11).
/// <para>
/// <c>DemoSeeder</c> provisions a real <c>device</c> row whose <c>token_hash</c> is
/// <c>SHA-256(Auth:DeviceToken)</c>, so the token already compiled into the PWA bundle
/// authenticates <em>for real</em> — as a genuine device bound to a genuine worker.
/// <c>StaticTokenDeviceAuthenticator</c> could therefore be deleted outright rather than kept
/// alongside a second code path, and <c>Auth:DeviceToken</c> stopped being a special case in code.
/// </para>
/// <para>
/// Each test gets its own database cloned from the migrated template, like the rest of the seeder
/// suite: "a database at an older seed state" only means something on a database nothing else has
/// touched.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class DemoIdentitySeedTests(TerenTestApp app)
{
    private const string DemoDeviceToken = TerenTestApp.DeviceToken;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_demo_device_carries_the_hash_of_the_configured_token()
    {
        // The hinge itself, asserted directly rather than inferred from a request succeeding.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        var stored = await ScalarAsync(
            db, "SELECT token_hash AS \"Value\" FROM device WHERE id = {0}", DemoSeeder.DemoDeviceId);

        stored.ShouldBe(CredentialTokens.Hash(DemoDeviceToken));
        stored.Length.ShouldBe(64);
    }

    [Fact]
    public async Task The_demo_device_belongs_to_the_demo_worker_and_the_demo_company()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        var owner = await ScalarAsync(
            db, "SELECT user_id::text AS \"Value\" FROM device WHERE id = {0}",
            DemoSeeder.DemoDeviceId);
        var tenant = await ScalarAsync(
            db, "SELECT company_id::text AS \"Value\" FROM device WHERE id = {0}",
            DemoSeeder.DemoDeviceId);

        owner.ShouldBe(DemoSeeder.WorkerId.ToString());
        tenant.ShouldBe(DemoSeeder.CompanyId.ToString());
    }

    [Fact]
    public async Task The_demo_company_gets_an_owner_and_a_foreman()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        var admin = await ScalarAsync(
            db, "SELECT role AS \"Value\" FROM app_user WHERE id = {0}", DemoSeeder.CompanyAdminId);
        var worker = await ScalarAsync(
            db, "SELECT role AS \"Value\" FROM app_user WHERE id = {0}", DemoSeeder.WorkerId);
        var workerUsername = await ScalarAsync(
            db, "SELECT username AS \"Value\" FROM app_user WHERE id = {0}", DemoSeeder.WorkerId);

        admin.ShouldBe("company_admin");
        worker.ShouldBe("worker");
        workerUsername.ShouldBe(DemoSeeder.WorkerUsername);
    }

    [Fact]
    public async Task Neither_seeded_user_has_a_password()
    {
        // The admin is invited, not provisioned with one; the worker may never have one at all
        // (ck_app_user_worker_has_no_password). A seed that shipped a password would be a
        // credential in the repository.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        var withPasswords = await CountAsync(
            db, "SELECT count(*)::int AS \"Value\" FROM app_user WHERE password_hash IS NOT NULL");

        withPasswords.ShouldBe(0);
    }

    [Fact]
    public async Task Seeding_twice_writes_no_identity_rows_the_second_time()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct)).ShouldBe(0);

        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM app_user")).ShouldBe(2);
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM device")).ShouldBe(1);
    }

    [Fact]
    public async Task A_rotated_token_is_picked_up_rather_than_silently_ignored()
    {
        // The one deliberate exception to "existing rows are never updated", and the reason for
        // it: everything else the seeder writes is demo CONTENT, which the founder may have
        // edited on purpose. The device row is a CREDENTIAL DERIVED FROM CONFIGURATION. If it
        // kept a stale hash after Auth__DeviceToken was rotated, `seed` would report success and
        // every phone would get 401 with nothing anywhere saying why.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, "the-first-device-token-value", publishDemoCode: true, Ct);

        var inserted = await DemoSeeder.SeedAsync(db, "a-completely-different-token", publishDemoCode: true, Ct);

        inserted.ShouldBe(1);
        (await ScalarAsync(
                db, "SELECT token_hash AS \"Value\" FROM device WHERE id = {0}",
                DemoSeeder.DemoDeviceId))
            .ShouldBe(CredentialTokens.Hash("a-completely-different-token"));

        // Still one phone, not two.
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM device")).ShouldBe(1);
    }

    [Fact]
    public async Task An_unchanged_token_leaves_the_device_row_alone()
    {
        // The upsert must not make every re-seed report work it did not do.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task A_host_with_no_device_token_seeds_the_demo_without_a_phone()
    {
        // The D7 end state, reachable today: the PWA stops carrying a baked-in token and the demo
        // device is retired. That is a working seed, not a failure — Program.cs says so once at
        // start-up rather than refusing to boot.
        await using var db = await app.CreateScratchDatabaseAsync();

        var inserted = await DemoSeeder.SeedAsync(db, deviceToken: null, publishDemoCode: true, ct: Ct);

        inserted.ShouldBe(10); // the full seed less the device
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM device")).ShouldBe(0);
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM app_user")).ShouldBe(2);
    }

    [Fact]
    public async Task The_seeded_identity_ids_are_part_of_the_same_contract()
    {
        // Pinned as literals, like the site ids, and for the same reason: they belong to the
        // d3a0c1f0- family the PWA and the deploy scripts are written against.
        DemoSeeder.CompanyAdminId.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-0000000000a1"));
        DemoSeeder.WorkerId.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-0000000000a2"));
        DemoSeeder.DemoDeviceId.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-0000000000dd"));
    }

    [Fact]
    public async Task The_seeded_entries_were_recorded_by_the_seeded_phone()
    {
        // entry.device_id was already being stamped with this id before the device table existed.
        // Now that the row is real the two must agree, or the demo archive shows provenance
        // pointing at a phone nobody can find.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        var orphaned = await CountAsync(
            db,
            """
            SELECT count(*)::int AS "Value" FROM entry
            WHERE device_id IS NOT NULL
              AND device_id NOT IN (SELECT id FROM device)
            """);

        orphaned.ShouldBe(0);
    }

    // ---------------------------------------------------------------- the demo activation code

    [Fact]
    public async Task Seeding_mints_the_fixed_demo_activation_code()
    {
        // Without it a fresh install or a new browser reaches /welcome and stops there: F4's gate
        // keys on having a session, there is no admin screen to issue a code from until F6, and
        // the seeded company admin has no password. "Main is always demo-ready" (invariant 6) is
        // this row.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        var display = await ScalarAsync(
            db,
            """
            SELECT code_display AS "Value" FROM activation_code
            WHERE user_id = {0} AND consumed_at IS NULL AND superseded_at IS NULL
            """,
            DemoSeeder.WorkerId);
        var hash = await ScalarAsync(
            db,
            """
            SELECT code_hash AS "Value" FROM activation_code
            WHERE user_id = {0} AND consumed_at IS NULL AND superseded_at IS NULL
            """,
            DemoSeeder.WorkerId);

        display.ShouldBe("DEM0-TEST");
        display.ShouldBe(DemoSeeder.DemoActivationCodeDisplay);

        // The property that actually matters: what the demo script tells a man to type folds to
        // exactly the code that was hashed. A display value that did not would be a code that is
        // written down everywhere and works nowhere.
        hash.ShouldBe(CredentialTokens.Hash(ActivationCodeFormat.Fold(display)));
        ActivationCodeFormat.TryParse(display, out var typed).ShouldBeTrue();
        typed.ShouldBe(DemoSeeder.DemoActivationCode);
    }

    [Fact]
    public async Task The_demo_code_outlives_the_seven_day_default()
    {
        // A real code is a credential emailed to one man and dies in seven days by design. This
        // one is seeded data published in the repository, and a code that quietly expired a week
        // after the last seed is discovered by the distributor mid-pitch.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        var stillLiveInAYear = await CountAsync(
            db,
            $"""
             SELECT count(*)::int AS "Value" FROM activation_code
             WHERE user_id = '{DemoSeeder.WorkerId}'
               AND consumed_at IS NULL AND superseded_at IS NULL
               AND expires_at > now() + interval '1 year'
             """);

        stillLiveInAYear.ShouldBe(1);
    }

    [Fact]
    public async Task Seeding_twice_leaves_exactly_one_live_demo_code()
    {
        // ux_activation_code_live would refuse a second one anyway — this is the assertion that
        // the seeder does not try, and that a re-seed still reports no work.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct)).ShouldBe(0);

        (await LiveCodeCountAsync(db)).ShouldBe(1);
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM activation_code"))
            .ShouldBe(1);
    }

    [Fact]
    public async Task A_consumed_demo_code_is_re_minted_by_the_next_seed()
    {
        // The demo script asks the distributor to spend this code once, on his own phone. Without
        // the re-mint, the next man to open the app on a fresh browser finds a demo he cannot
        // join, and `seed` reports success while he does.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             UPDATE activation_code SET consumed_at = now(), code_display = NULL
             WHERE user_id = {DemoSeeder.WorkerId}
             """,
            Ct);

        (await LiveCodeCountAsync(db)).ShouldBe(0);
        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct)).ShouldBe(1);

        (await LiveCodeCountAsync(db)).ShouldBe(1);
        (await ScalarAsync(
                db,
                """
                SELECT code_display AS "Value" FROM activation_code
                WHERE user_id = {0} AND consumed_at IS NULL AND superseded_at IS NULL
                """,
                DemoSeeder.WorkerId))
            .ShouldBe(DemoSeeder.DemoActivationCodeDisplay);

        // The spent row stays spent. Single use is the one point the design refuses to bend on,
        // and "the seed heals the demo" must never become "the seed un-consumes a code".
        (await CountAsync(
                db,
                $"""
                 SELECT count(*)::int AS "Value" FROM activation_code
                 WHERE user_id = '{DemoSeeder.WorkerId}' AND consumed_at IS NOT NULL
                 """))
            .ShouldBe(1);
    }

    [Fact]
    public async Task An_expired_demo_code_is_superseded_and_replaced()
    {
        // ux_activation_code_live still counts an expired-but-unconsumed row as live (its
        // predicate cannot mention now()), so the replacement is only possible if the seeder
        // retires it first — and retiring it is also where its plaintext finally goes.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             UPDATE activation_code SET expires_at = now() - interval '1 day'
             WHERE user_id = {DemoSeeder.WorkerId}
             """,
            Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct)).ShouldBe(2); // superseded + minted

        (await LiveCodeCountAsync(db)).ShouldBe(1);
        (await CountAsync(
                db,
                $"""
                 SELECT count(*)::int AS "Value" FROM activation_code
                 WHERE user_id = '{DemoSeeder.WorkerId}'
                   AND superseded_at IS NOT NULL AND code_display IS NOT NULL
                 """))
            .ShouldBe(0);
    }

    [Fact]
    public async Task A_code_someone_else_issued_is_retired_so_the_fixed_one_comes_back()
    {
        // An admin pressing "issue a new code" for the demo worker supersedes the fixed one. The
        // seed is the way back, exactly as it is for a revoked demo phone.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             UPDATE activation_code SET superseded_at = now(), code_display = NULL
             WHERE user_id = {DemoSeeder.WorkerId}
             """,
            Ct);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO activation_code
                 (id, company_id, user_id, created_by_user_id, code_hash, code_display,
                  created_at, expires_at)
             VALUES ({Guid.NewGuid()}, {DemoSeeder.CompanyId}, {DemoSeeder.WorkerId},
                     {DemoSeeder.CompanyAdminId}, {new string('a', 64)}, {"XKD4-7HMP"},
                     {DateTime.UtcNow}, {DateTime.UtcNow.AddDays(7)})
             """,
            Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, publishDemoCode: true, Ct)).ShouldBe(2);

        (await LiveCodeCountAsync(db)).ShouldBe(1);
        (await ScalarAsync(
                db,
                """
                SELECT code_display AS "Value" FROM activation_code
                WHERE user_id = {0} AND consumed_at IS NULL AND superseded_at IS NULL
                """,
                DemoSeeder.WorkerId))
            .ShouldBe(DemoSeeder.DemoActivationCodeDisplay);
    }

    [Fact]
    public async Task The_demo_code_is_part_of_the_same_written_down_contract()
    {
        // Pinned as a literal like the site ids, and for the same reason: it is written down in
        // CLAUDE.md and in docs/demo-script.md, and a change here would silently invalidate both.
        DemoSeeder.DemoActivationCode.ShouldBe("DEM0TEST");
        DemoSeeder.DemoActivationCodeDisplay.ShouldBe("DEM0-TEST");
    }

    private static Task<int> LiveCodeCountAsync(DbContext db) =>
        CountAsync(
            db,
            $"""
             SELECT count(*)::int AS "Value" FROM activation_code
             WHERE user_id = '{DemoSeeder.WorkerId}'
               AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > now()
             """);

    private static async Task<string> ScalarAsync(DbContext db, string sql, Guid id) =>
        (await db.Database.SqlQueryRaw<string>(sql, id).ToListAsync(Ct)).Single();

    private static async Task<int> CountAsync(DbContext db, string sql) =>
        (await db.Database.SqlQueryRaw<int>(sql).ToListAsync(Ct)).Single();
}

/// <summary>
/// The published demo code, and the default that keeps it off a public box.
/// <para>
/// <c>DemoSeeder.DemoActivationCode</c> is written down in the source and in
/// <c>docs/demo-script.md</c>, so it is a live credential to the demo company that anyone who can
/// read the repository already holds. On a laptop that costs nothing; behind a public URL it is a
/// way in, and redeeming it revokes the demo phone until the next seed.
/// </para>
/// </summary>
public sealed class DemoCodePublicationTests(TerenTestApp app) : ApiTestBase(app)
{
    private static async Task<bool> HasDemoCodeAsync(DbContext db)
    {
        var hash = CredentialTokens.Hash(DemoSeeder.DemoActivationCode);
        var rows = await db.Database.SqlQueryRaw<int>(
            """
            SELECT 1 AS "Value" FROM activation_code
             WHERE code_hash = {0} AND consumed_at IS NULL AND superseded_at IS NULL
            """,
            hash).ToListAsync(TestContext.Current.CancellationToken);
        return rows.Count > 0;
    }

    [Fact]
    public async Task The_published_demo_code_is_not_minted_unless_the_caller_asks_for_it()
    {
        // The default, which is what a caller who did not think about it gets. **That is the whole
        // protection**: a staging host nobody reasoned about seeds a demo worker with no code —
        // visible at once and fixed from `/company` — rather than a live credential nobody notices
        // until somebody uses it.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, deviceToken: null, ct: Ct);

        (await HasDemoCodeAsync(db)).ShouldBeFalse();
    }

    [Fact]
    public async Task Asking_for_it_mints_it()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, deviceToken: null, publishDemoCode: true, ct: Ct);

        (await HasDemoCodeAsync(db)).ShouldBeTrue();
    }
}
