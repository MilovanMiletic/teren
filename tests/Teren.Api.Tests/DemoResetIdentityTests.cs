using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Identity;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// <c>reset-demo</c> against the identity tables (profile-and-identity §13.3).
/// <para>
/// <c>DemoReset</c>'s ordered delete, its foreign-row fingerprint, <see cref="DemoRowCounts"/> and
/// <c>TerenTestApp.ResetAsync</c>'s TRUNCATE list all grow together or the reset's safety assertion
/// gains a blind spot — and this is the only code in the product allowed to stand the immutability
/// guard down, so a blind spot here is not like a blind spot anywhere else.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class DemoResetIdentityTests(TerenTestApp app)
{
    private const string DemoDeviceToken = TerenTestApp.DeviceToken;

    private static readonly Guid SuperAdminId = Guid.Parse("99999999-0000-4000-8000-000000000001");
    private static readonly Guid OtherCompanyId = Guid.Parse("11111111-2222-3333-4444-555555555555");
    private static readonly Guid OtherWorkerId = Guid.Parse("11111111-2222-3333-4444-555555555560");
    private static readonly Guid OtherDeviceId = Guid.Parse("11111111-2222-3333-4444-555555555561");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // ---------------------------------------------------------------- the ordered delete

    [Fact]
    public async Task The_demo_users_codes_sessions_and_phone_all_go_and_come_back()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);
        await GivenDemoIdentityJunkAsync(db);

        var result = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        result.Removed.AppUsers.ShouldBe(2);
        result.Removed.Devices.ShouldBe(1);
        // The junk code plus the seeded demo code: `seed` mints a live one now, and a reset
        // clears the demo company down to the bone before re-seeding it.
        result.Removed.ActivationCodes.ShouldBe(2);
        result.Removed.PasswordTokens.ShouldBe(1);
        result.Removed.AdminSessions.ShouldBe(1);
        result.Removed.AdminAudits.ShouldBe(1);

        // Back to a demo that can actually be given: two people and one working phone.
        result.FinalState.AppUsers.ShouldBe(2);
        result.FinalState.Devices.ShouldBe(1);
        // Exactly one live code — drawn here, since this call does not ask for the published one
        // — without which a fresh phone cannot get past the welcome screen and the reset would
        // hand back an undemonstrable demo.
        result.FinalState.ActivationCodes.ShouldBe(1);
        result.FinalState.AdminSessions.ShouldBe(0);
    }

    [Fact]
    public async Task The_phone_that_comes_back_can_still_authenticate()
    {
        // The failure this guards against is the quiet one: a reset that restores every row and
        // leaves the distributor holding a phone that 401s in front of a customer.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);

        await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        var hashes = await db.Database
            .SqlQueryRaw<string>("SELECT token_hash AS \"Value\" FROM device")
            .ToListAsync(Ct);

        hashes.ShouldHaveSingleItem().ShouldBe(CredentialTokens.Hash(DemoDeviceToken));
    }

    [Fact]
    public async Task Another_companys_people_and_phones_are_untouched()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);
        await GivenAnotherCompanyWithPeopleAsync(db);

        var result = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        result.Removed.AppUsers.ShouldBe(2);   // the demo's two, not the neighbour's
        result.Removed.Devices.ShouldBe(1);

        (await CountAsync(db, $"SELECT count(*)::int AS \"Value\" FROM app_user WHERE id = '{OtherWorkerId}'"))
            .ShouldBe(1);
        (await CountAsync(db, $"SELECT count(*)::int AS \"Value\" FROM device WHERE id = '{OtherDeviceId}'"))
            .ShouldBe(1);
    }

    // ---------------------------------------------------------------- the NULL-safe fingerprint

    [Fact]
    public async Task A_super_admin_survives_a_reset()
    {
        // A super_admin has company_id NULL — that is how the role is spelled
        // (ck_app_user_company_scope). He belongs to no tenant and must therefore be no tenant's
        // business, this command's included.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);
        await GivenSuperAdminAsync(db);

        await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        (await CountAsync(
                db, $"SELECT count(*)::int AS \"Value\" FROM app_user WHERE id = '{SuperAdminId}'"))
            .ShouldBe(1);
    }

    [Fact]
    public async Task The_foreign_row_fingerprint_can_see_a_super_admin()
    {
        // The test the whole file exists for, and it is about a live defect rather than a
        // hypothetical one.
        //
        // The fingerprint counts every row the reset must NOT touch, before and after the deletes
        // inside the same transaction, and rolls back on a single row of difference. It used to do
        // that with `company_id <> {demo}`. app_user.company_id is NULLABLE, and
        // `NULL <> '...'` is NULL rather than true — so a super_admin row was counted as neither
        // the demo's nor anybody else's and dropped out of the fingerprint entirely. The one piece
        // of code in Teren allowed to disable the evidence guard had a blind spot exactly the
        // shape of the account with the most reach in the product.
        //
        // Proving that a count is NULL-safe cannot be done by reading rows afterwards, because a
        // correct reset touches nothing either way. So this test makes the reset genuinely
        // destructive from the inside: an interceptor deletes the super_admin on the reset's own
        // connection and transaction, after the deletes and before the second fingerprint is
        // taken. With IS DISTINCT FROM the counts differ and the whole transaction rolls back.
        // With `<>` both counts are zero, nothing is noticed, and the row is gone.
        await using var interceptor = new DeleteSuperAdminMidTransaction(SuperAdminId);
        await using var db = await app.CreateScratchDatabaseAsync(null, interceptor);

        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);
        await GivenSuperAdminAsync(db);
        db.ChangeTracker.Clear();

        interceptor.Arm();

        var refusal = await Should.ThrowAsync<InvalidOperationException>(async () =>
            await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct));

        interceptor.Fired.ShouldBeTrue("nothing was deleted, so nothing was proven");
        refusal.Message.ShouldContain("outside the demo company");

        db.ChangeTracker.Clear();

        // Rolled back whole: the super admin is still there, and so is the demo.
        (await CountAsync(
                db, $"SELECT count(*)::int AS \"Value\" FROM app_user WHERE id = '{SuperAdminId}'"))
            .ShouldBe(1);
        (await CountAsync(db, "SELECT count(*)::int AS \"Value\" FROM entry")).ShouldBe(3);
    }

    // ---------------------------------------------------------------- arrange helpers

    /// <summary>What a few demos and a bit of admin work leave behind on the identity side.</summary>
    private static async Task GivenDemoIdentityJunkAsync(TerenDbContext db)
    {
        var now = DateTime.UtcNow;

        // A code that was already spent joining a phone during an earlier demo. It has to be a
        // CONSUMED row rather than a live one: `seed` now mints the fixed demo code, and
        // ux_activation_code_live permits exactly one live code per worker — a second live row
        // here would be refused by the database, which is the design working.
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO activation_code
                 (id, company_id, user_id, created_by_user_id, code_hash, code_display,
                  created_at, expires_at, consumed_at)
             VALUES ({Guid.NewGuid()}, {DemoSeeder.CompanyId}, {DemoSeeder.WorkerId},
                     {DemoSeeder.CompanyAdminId}, {new string('a', 64)}, {null as string},
                     {now}, {now.AddDays(7)}, {now})
             """,
            Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO password_token (id, user_id, purpose, token_hash, created_at, expires_at)
             VALUES ({Guid.NewGuid()}, {DemoSeeder.CompanyAdminId}, {"invite"},
                     {new string('b', 64)}, {now}, {now.AddDays(2)})
             """,
            Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO admin_session
                 (id, user_id, token_hash, created_at, last_seen_at, expires_at)
             VALUES ({Guid.NewGuid()}, {DemoSeeder.CompanyAdminId}, {new string('c', 64)},
                     {now}, {now}, {now.AddDays(30)})
             """,
            Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO admin_audit
                 (id, actor_user_id, action, subject_type, subject_id, company_id, created_at)
             VALUES ({Guid.NewGuid()}, {DemoSeeder.CompanyAdminId}, {"device_revoked"},
                     {"device"}, {DemoSeeder.DemoDeviceId}, {DemoSeeder.CompanyId}, {now})
             """,
            Ct);
    }

    private static Task GivenSuperAdminAsync(TerenDbContext db) =>
        db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO app_user
                 (id, company_id, role, username, display_name, email, password_hash, language,
                  created_at)
             VALUES ({SuperAdminId}, NULL, {"super_admin"}, NULL, {"Teren osoblje"},
                     {"osoblje@teren.rs"}, NULL, 'sr', {DateTime.UtcNow})
             """,
            Ct);

    private static async Task GivenAnotherCompanyWithPeopleAsync(TerenDbContext db)
    {
        var now = DateTime.UtcNow;

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO company (id, name, created_at) VALUES ({OtherCompanyId}, {"Druga firma d.o.o."}, {now})",
            Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO app_user
                 (id, company_id, role, username, display_name, email, password_hash, language,
                  created_at)
             VALUES ({OtherWorkerId}, {OtherCompanyId}, {"worker"}, {"tudji.radnik"},
                     {"Tuđi Radnik"}, NULL, NULL, 'sr', {now})
             """,
            Ct);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO device (id, company_id, user_id, name, token_hash, created_at)
             VALUES ({OtherDeviceId}, {OtherCompanyId}, {OtherWorkerId}, {"Tudji telefon"},
                     {new string('d', 64)}, {now})
             """,
            Ct);
    }

    private static async Task<int> CountAsync(DbContext db, string sql) =>
        (await db.Database.SqlQueryRaw<int>(sql).ToListAsync(Ct)).Single();

    /// <summary>
    /// Deletes one super_admin row on the reset's <b>own connection and transaction</b>, timed to
    /// land after every delete and before the second foreign-row fingerprint is taken.
    /// <para>
    /// It has to be the same transaction: a second connection could not see the uncommitted work
    /// and would block on the locks the reset holds. Hooking <c>ENABLE TRIGGER</c> is what puts it
    /// in the right window — that statement runs after the deletes and before
    /// <c>CountForeignRowsAsync</c> is called the second time.
    /// </para>
    /// </summary>
    private sealed class DeleteSuperAdminMidTransaction(Guid userId)
        : DbCommandInterceptor, IAsyncDisposable
    {
        private int _fired;
        private volatile bool _armed;

        public bool Fired => _fired > 0;

        public void Arm() => _armed = true;

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            if (_armed
                && command.CommandText.Contains("ENABLE TRIGGER", StringComparison.Ordinal)
                && Interlocked.Exchange(ref _fired, 1) == 0)
            {
                await using var sabotage = command.Connection!.CreateCommand();
                sabotage.Transaction = command.Transaction;
                sabotage.CommandText = $"DELETE FROM app_user WHERE id = '{userId}'";
                await sabotage.ExecuteNonQueryAsync(cancellationToken);
            }

            return await base.NonQueryExecutingAsync(
                command, eventData, result, cancellationToken);
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
