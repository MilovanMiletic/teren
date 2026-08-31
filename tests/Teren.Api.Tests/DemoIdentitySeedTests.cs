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
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        var stored = await ScalarAsync(
            db, "SELECT token_hash AS \"Value\" FROM device WHERE id = {0}", DemoSeeder.DemoDeviceId);

        stored.ShouldBe(CredentialTokens.Hash(DemoDeviceToken));
        stored.Length.ShouldBe(64);
    }

    [Fact]
    public async Task The_demo_device_belongs_to_the_demo_worker_and_the_demo_company()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

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
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

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
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        var withPasswords = await CountAsync(
            db, "SELECT count(*)::int AS \"Value\" FROM app_user WHERE password_hash IS NOT NULL");

        withPasswords.ShouldBe(0);
    }

    [Fact]
    public async Task Seeding_twice_writes_no_identity_rows_the_second_time()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct)).ShouldBe(0);

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
        await DemoSeeder.SeedAsync(db, "the-first-device-token-value", Ct);

        var inserted = await DemoSeeder.SeedAsync(db, "a-completely-different-token", Ct);

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
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task A_host_with_no_device_token_seeds_the_demo_without_a_phone()
    {
        // The D7 end state, reachable today: the PWA stops carrying a baked-in token and the demo
        // device is retired. That is a working seed, not a failure — Program.cs says so once at
        // start-up rather than refusing to boot.
        await using var db = await app.CreateScratchDatabaseAsync();

        var inserted = await DemoSeeder.SeedAsync(db, deviceToken: null, ct: Ct);

        inserted.ShouldBe(9); // the full seed less the device
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
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        var orphaned = await CountAsync(
            db,
            """
            SELECT count(*)::int AS "Value" FROM entry
            WHERE device_id IS NOT NULL
              AND device_id NOT IN (SELECT id FROM device)
            """);

        orphaned.ShouldBe(0);
    }

    private static async Task<string> ScalarAsync(DbContext db, string sql, Guid id) =>
        (await db.Database.SqlQueryRaw<string>(sql, id).ToListAsync(Ct)).Single();

    private static async Task<int> CountAsync(DbContext db, string sql) =>
        (await db.Database.SqlQueryRaw<int>(sql).ToListAsync(Ct)).Single();
}
