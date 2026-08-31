using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Identity;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// The way back from every state that can leave a seeded demo unable to authenticate.
/// <para>
/// D1's demo-ready promise was "revocation becomes possible from psql". A capability whose only
/// exit is another hand-written UPDATE is not one the founder can use in front of a customer, so
/// <c>seed</c> — the command he already reaches for — has to be the way back. Three stamps can
/// withdraw the demo phone's credential, and <c>seed</c> clears all three while still never
/// overwriting demo <em>content</em>.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class DemoRecoveryTests(TerenTestApp app)
{
    private const string DemoDeviceToken = TerenTestApp.DeviceToken;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // ---------------------------------------------------------------- withdrawal stamps

    [Fact]
    public async Task Re_seeding_brings_a_revoked_demo_phone_back()
    {
        // Revoke, re-seed, and the phone works again — without the founder having to know that
        // the fix is a second UPDATE nobody wrote down.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             UPDATE device SET revoked_at = now(), revoked_by_user_id = {DemoSeeder.CompanyAdminId}
             WHERE id = {DemoSeeder.DemoDeviceId}
             """,
            Ct);

        var written = await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        written.ShouldBe(1, "the re-seed reported no work, so the demo is still dead");
        await AssertDemoPhoneUsableAsync(db);
    }

    [Fact]
    public async Task Re_seeding_re_enables_a_disabled_demo_worker()
    {
        // Same class, same silence: the credential check requires app_user.disabled_at IS NULL,
        // so a disabled worker is a dead phone with a different cause.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE app_user SET disabled_at = now() WHERE id = {DemoSeeder.WorkerId}", Ct);

        var written = await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        written.ShouldBe(1);
        await AssertDemoPhoneUsableAsync(db);
    }

    [Fact]
    public async Task Re_seeding_resumes_a_suspended_demo_company()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE company SET suspended_at = now() WHERE id = {DemoSeeder.CompanyId}", Ct);

        var written = await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        written.ShouldBe(1);
        await AssertDemoPhoneUsableAsync(db);
    }

    [Fact]
    public async Task All_three_withdrawals_at_once_are_cleared_by_one_re_seed()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE device SET revoked_at = now() WHERE id = {DemoSeeder.DemoDeviceId}", Ct);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE app_user SET disabled_at = now() WHERE id = {DemoSeeder.WorkerId}", Ct);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE company SET suspended_at = now() WHERE id = {DemoSeeder.CompanyId}", Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct)).ShouldBe(3);

        await AssertDemoPhoneUsableAsync(db);
    }

    [Fact]
    public async Task Restoring_a_credential_never_restores_content_the_founder_edited()
    {
        // The line the exception must not cross. Clearing a withdrawal stamp is putting the demo
        // back into a state it can be given from; rewriting a name the founder changed on purpose
        // is the upsert this seeder has always refused to be.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             UPDATE app_user SET display_name = 'Ime koje je vlasnik izmenio', disabled_at = now()
             WHERE id = {DemoSeeder.WorkerId}
             """,
            Ct);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE company SET name = 'Preimenovana firma' WHERE id = {DemoSeeder.CompanyId}",
            Ct);

        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        (await ScalarAsync(db, "SELECT display_name AS \"Value\" FROM app_user WHERE id = {0}",
                DemoSeeder.WorkerId))
            .ShouldBe("Ime koje je vlasnik izmenio");
        (await ScalarAsync(db, "SELECT name AS \"Value\" FROM company WHERE id = {0}",
                DemoSeeder.CompanyId))
            .ShouldBe("Preimenovana firma");

        // ...but the stamp that made the demo unusable is gone.
        await AssertDemoPhoneUsableAsync(db);
    }

    [Fact]
    public async Task An_untouched_demo_still_reports_no_work_on_a_re_seed()
    {
        // The whole restore is behind a WHERE, so idempotence is unaffected: the ordinary case
        // must still be a no-op, or every `seed` would claim to have done something.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct)).ShouldBe(0);
        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct)).ShouldBe(0);
    }

    // ---------------------------------------------------------------- the cross-tenant guard

    [Fact]
    public async Task A_device_cannot_be_bound_to_another_companys_worker()
    {
        // Finding 6. company_id and user_id are independent foreign keys, so without the
        // composite one this row is legal — and because the authenticator stamps entries from
        // device.company_id, it would attribute one company's evidence to another company's NAMED
        // MAN. Unreachable today, because only the seeder and the fixture insert devices; D3's
        // activation endpoint is what makes it writable.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        var otherCompany = await GivenAnotherCompanyAsync(db);

        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"""
                 INSERT INTO device (id, company_id, user_id, name, token_hash, created_at)
                 VALUES ({Guid.NewGuid()}, {otherCompany}, {DemoSeeder.WorkerId},
                         {"Ukradeni telefon"}, {new string('e', 64)}, {DateTime.UtcNow})
                 """,
                Ct));

        ex.ConstraintName.ShouldBe("fk_device_company_user");
    }

    [Fact]
    public async Task An_activation_code_cannot_be_issued_into_another_companys_worker()
    {
        // The same hole on the other writable table: a code carrying company A but naming
        // company B's worker would activate a phone that records under his name into A.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        var otherCompany = await GivenAnotherCompanyAsync(db);

        var now = DateTime.UtcNow;
        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"""
                 INSERT INTO activation_code
                     (id, company_id, user_id, created_by_user_id, code_hash, code_display,
                      created_at, expires_at)
                 VALUES ({Guid.NewGuid()}, {otherCompany}, {DemoSeeder.WorkerId},
                         {DemoSeeder.CompanyAdminId}, {new string('f', 64)}, {"XKD4-7HMP"},
                         {now}, {now.AddDays(7)})
                 """,
                Ct));

        ex.ConstraintName.ShouldBe("fk_activation_code_company_user");
    }

    [Fact]
    public async Task A_device_bound_to_its_own_companys_worker_is_of_course_fine()
    {
        // The guard must block what it is meant to block and nothing else.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO device (id, company_id, user_id, name, token_hash, created_at)
             VALUES ({Guid.NewGuid()}, {DemoSeeder.CompanyId}, {DemoSeeder.WorkerId},
                     {"Zoranov drugi telefon"}, {new string('9', 64)}, {DateTime.UtcNow})
             """,
            Ct);

        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM device")).ShouldBe(2);
    }

    [Fact]
    public async Task Platform_staff_can_still_issue_a_code_and_revoke_a_phone()
    {
        // Deliberately NOT covered by a composite key: created_by_user_id and
        // revoked_by_user_id. Decision 10 lets a super admin manage users across every company,
        // and a super admin has no company_id — so a composite key on either column would make
        // platform staff structurally unable to do the job the role exists for. Who may act is a
        // role gate (D2), not a schema constraint.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        var staffId = Guid.NewGuid();
        var now = DateTime.UtcNow;

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO app_user
                 (id, company_id, role, username, display_name, email, password_hash, language,
                  created_at)
             VALUES ({staffId}, NULL, {"super_admin"}, NULL, {"Teren osoblje"},
                     {"osoblje@teren.rs"}, NULL, 'sr', {now})
             """,
            Ct);

        await Should.NotThrowAsync(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"""
                 INSERT INTO activation_code
                     (id, company_id, user_id, created_by_user_id, code_hash, created_at,
                      expires_at)
                 VALUES ({Guid.NewGuid()}, {DemoSeeder.CompanyId}, {DemoSeeder.WorkerId},
                         {staffId}, {new string('1', 64)}, {now}, {now.AddDays(7)})
                 """,
                Ct));

        await Should.NotThrowAsync(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"""
                 UPDATE device SET revoked_at = {now}, revoked_by_user_id = {staffId}
                 WHERE id = {DemoSeeder.DemoDeviceId}
                 """,
                Ct));
    }

    // ---------------------------------------------------------------- helpers

    /// <summary>
    /// Asserts the demo phone would authenticate: the exact join
    /// <c>DbCredentialAuthenticator</c> makes, run against the same rows. Stated as the join
    /// rather than as three separate column checks so that a fourth withdrawal stamp added later
    /// cannot pass this by being somewhere nobody thought to look.
    /// </summary>
    private static async Task AssertDemoPhoneUsableAsync(TerenDbContext db)
    {
        var usable = await CountAsync(
            db,
            $"""
             SELECT count(*)::int AS "Value"
             FROM device d
             JOIN app_user u ON u.id = d.user_id
             JOIN company c ON c.id = d.company_id
             WHERE d.token_hash = '{CredentialTokens.Hash(DemoDeviceToken)}'
               AND d.revoked_at IS NULL
               AND u.disabled_at IS NULL
               AND c.suspended_at IS NULL
             """);

        usable.ShouldBe(1, "the seeded demo phone would still be refused a token");
    }

    private static async Task<Guid> GivenAnotherCompanyAsync(TerenDbContext db)
    {
        var id = Guid.NewGuid();

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO company (id, name, created_at) VALUES ({id}, {"Druga firma"}, {DateTime.UtcNow})",
            Ct);

        return id;
    }

    private static async Task<string> ScalarAsync(DbContext db, string sql, Guid id) =>
        (await db.Database.SqlQueryRaw<string>(sql, id).ToListAsync(Ct)).Single();

    private static async Task<int> CountAsync(DbContext db, string sql) =>
        (await db.Database.SqlQueryRaw<int>(sql).ToListAsync(Ct)).Single();
}
