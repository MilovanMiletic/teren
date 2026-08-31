using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// The identity schema's guarantees, attempted as illegal INSERTs against real Postgres — the same
/// shape <see cref="EntryImmutabilityTests"/> uses, and for the same reason: a rule that only the
/// application enforces is a rule any future migration script, psql session or ORM change walks
/// straight around.
/// <para>
/// The role rules in particular are meant to be <b>mechanical rather than conventional</b>
/// (profile-and-identity §4). <c>ck_app_user_company_scope</c> is the one to read twice: with it in
/// place, no INSERT, no UPDATE and no migration can produce a super_admin row that a tenant query
/// filter would ever match.
/// </para>
/// </summary>
public sealed class IdentitySchemaTests(TerenTestApp app) : ApiTestBase(app)
{
    // ------------------------------------------------------------ app_user role rules

    [Fact]
    public async Task A_super_admin_inside_a_tenant_is_impossible()
    {
        // The row the whole privacy claim depends on not existing.
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.SuperAdmin,
            companyId: TestIds.CompanyA,
            username: null,
            email: "osoblje@teren.rs"));

        ex.ConstraintName.ShouldBe("ck_app_user_company_scope");
    }

    [Fact]
    public async Task A_company_admin_with_no_company_is_impossible()
    {
        // The same constraint read the other way: only a super admin may be tenantless.
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.CompanyAdmin,
            companyId: null,
            username: null,
            email: "vlasnik@example.com"));

        ex.ConstraintName.ShouldBe("ck_app_user_company_scope");
    }

    [Fact]
    public async Task An_admin_with_no_email_can_never_be_reset_so_cannot_exist()
    {
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.CompanyAdmin,
            companyId: TestIds.CompanyA,
            username: null,
            email: null));

        ex.ConstraintName.ShouldBe("ck_app_user_admin_has_email");
    }

    [Fact]
    public async Task A_worker_with_a_password_is_impossible()
    {
        // A second door into the diary. There is exactly one door and it is the device: the whole
        // activation model exists so a foreman never types a password on a site.
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.Worker,
            companyId: TestIds.CompanyA,
            username: "nenad.ilic",
            email: null,
            passwordHash: "pbkdf2-sha256$600000$c2FsdA==$aGFzaA=="));

        ex.ConstraintName.ShouldBe("ck_app_user_worker_has_no_password");
    }

    [Fact]
    public async Task A_worker_with_no_username_is_impossible()
    {
        // His username is his durable identity and outlives every phone he ever holds.
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.Worker,
            companyId: TestIds.CompanyA,
            username: null,
            email: null));

        ex.ConstraintName.ShouldBe("ck_app_user_worker_has_username");
    }

    [Fact]
    public async Task A_role_outside_the_three_is_impossible()
    {
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: "owner",   // ARCHITECTURE §12's old planned vocabulary
            companyId: TestIds.CompanyA,
            username: null,
            email: "vlasnik@example.com"));

        ex.ConstraintName.ShouldBe("ck_app_user_role");
    }

    [Fact]
    public async Task A_super_admin_with_no_company_is_perfectly_legal()
    {
        // The guard must block what it is meant to block and nothing else: a suite that only
        // proved refusals would pass against a schema that refused everything.
        await InsertUserAsync(
            role: AppUserRoleNames.SuperAdmin,
            companyId: null,
            username: null,
            email: "osoblje@teren.rs");

        await using var identity = App.CreateIdentityDbContext();
        var staff = await identity.Users
            .SingleAsync(u => u.Email == "osoblje@teren.rs", Ct);

        staff.Role.ShouldBe(AppUserRole.SuperAdmin);
        staff.CompanyId.ShouldBeNull();
    }

    // ------------------------------------------------------------ normalisation and uniqueness

    [Theory]
    [InlineData("Zoran@Example.RS")]
    [InlineData(" zoran@example.rs")]
    [InlineData("zoran@example.rs ")]
    public async Task An_email_that_is_not_normalised_is_refused(string email)
    {
        // Case-insensitivity comes from normalising on write rather than from citext — no
        // CREATE EXTENSION, following the "No PostGIS" precedent. The CHECK is what stops two
        // rows differing only in case, which the partial unique index alone would allow.
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.CompanyAdmin,
            companyId: TestIds.CompanyA,
            username: null,
            email: email));

        ex.ConstraintName.ShouldBe("ck_app_user_email_normalised");
    }

    [Fact]
    public async Task A_username_that_is_not_normalised_is_refused()
    {
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.Worker,
            companyId: TestIds.CompanyA,
            username: "Nenad.Ilic",
            email: null));

        ex.ConstraintName.ShouldBe("ck_app_user_username_normalised");
    }

    [Fact]
    public async Task A_username_is_unique_across_every_company()
    {
        // Global, not company-scoped, because the self-service re-activation flow looks a worker
        // up by username alone: a man standing next to a broken phone types one thing and is not
        // asked "which company?".
        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.Worker,
            companyId: TestIds.CompanyB,          // a different tenant entirely
            username: TestIds.WorkerAUsername,    // the fixture worker's username
            email: null));

        ex.ConstraintName.ShouldBe("ux_app_user_username");
    }

    [Fact]
    public async Task Admins_have_no_username_and_many_of_them_may_coexist()
    {
        // The index is partial for exactly this reason: NULLs must not collide.
        await InsertUserAsync(
            role: AppUserRoleNames.CompanyAdmin, companyId: TestIds.CompanyA,
            username: null, email: "prvi@example.com");
        await InsertUserAsync(
            role: AppUserRoleNames.CompanyAdmin, companyId: TestIds.CompanyA,
            username: null, email: "drugi@example.com");

        (await CountUsersAsync(
            "SELECT count(*)::int AS \"Value\" FROM app_user WHERE username IS NULL")).ShouldBe(2);
    }

    [Fact]
    public async Task An_email_is_unique_across_every_company()
    {
        // Global rather than per-company, because email is the login key and a login form has no
        // company field to disambiguate with.
        await InsertUserAsync(
            role: AppUserRoleNames.CompanyAdmin, companyId: TestIds.CompanyA,
            username: null, email: "vlasnik@example.com");

        var ex = await ShouldFailAsync(InsertUserAsync(
            role: AppUserRoleNames.CompanyAdmin, companyId: TestIds.CompanyB,
            username: null, email: "vlasnik@example.com"));

        ex.ConstraintName.ShouldBe("ux_app_user_email");
    }

    [Fact]
    public async Task Workers_without_an_email_do_not_collide_with_each_other()
    {
        // Decision 6 makes a worker's email optional, so onboarding never blocks on a missing
        // address. Two such workers are ordinary, not a conflict.
        await InsertUserAsync(
            role: AppUserRoleNames.Worker, companyId: TestIds.CompanyA,
            username: "nenad.ilic", email: null);
        await InsertUserAsync(
            role: AppUserRoleNames.Worker, companyId: TestIds.CompanyA,
            username: "milos.savic", email: null);

        (await CountUsersAsync(
            "SELECT count(*)::int AS \"Value\" FROM app_user WHERE email IS NULL"))
            .ShouldBe(3); // plus the fixture own worker
    }

    // ------------------------------------------------------------ device

    [Fact]
    public async Task Two_devices_cannot_share_a_token()
    {
        // ux_device_token_hash is not an ordinary index — it is the auth path, and a duplicate in
        // it would mean one token resolving to two companies.
        var ex = await ShouldFailAsync(InsertDeviceAsync(
            Guid.NewGuid(), TestIds.CompanyA, TestIds.WorkerA, FixtureDeviceTokenHash()));

        ex.ConstraintName.ShouldBe("ux_device_token_hash");
    }

    [Fact]
    public async Task A_user_who_owns_a_device_can_never_be_hard_deleted()
    {
        // Every foreign key into app_user is RESTRICT, deliberately: "remove a worker" is
        // disabled_at, never a DELETE, because evidence must not be degraded by an
        // administrative action.
        await using var db = App.CreateDbContext(companyId: null);

        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"DELETE FROM app_user WHERE id = {TestIds.WorkerA}", Ct));

        ex.SqlState.ShouldBe(PostgresErrorCodes.ForeignKeyViolation);
    }

    [Fact]
    public async Task A_company_with_users_can_never_be_hard_deleted()
    {
        await using var db = App.CreateDbContext(companyId: null);

        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"DELETE FROM company WHERE id = {TestIds.CompanyA}", Ct));

        ex.SqlState.ShouldBe(PostgresErrorCodes.ForeignKeyViolation);
    }

    // ------------------------------------------------------------ activation_code

    [Fact]
    public async Task One_worker_can_have_only_one_live_code()
    {
        // Guaranteed by the database rather than by a handler remembering to supersede the old
        // one — otherwise two codes are typeable at once and the single-use promise is only a
        // description of the happy path.
        await InsertCodeAsync(Guid.NewGuid());

        var ex = await ShouldFailAsync(InsertCodeAsync(Guid.NewGuid()));

        ex.ConstraintName.ShouldBe("ux_activation_code_live");
    }

    [Fact]
    public async Task A_consumed_code_does_not_block_a_new_one()
    {
        // Re-issue is the supported path (decision 14) and must not be blocked by history.
        await InsertCodeAsync(Guid.NewGuid(), consumedAt: DateTime.UtcNow, codeDisplay: null);
        await InsertCodeAsync(Guid.NewGuid());

        (await CountCodesAsync()).ShouldBe(2);
    }

    [Fact]
    public async Task A_superseded_code_does_not_block_a_new_one_either()
    {
        await InsertCodeAsync(Guid.NewGuid(), supersededAt: DateTime.UtcNow, codeDisplay: null);
        await InsertCodeAsync(Guid.NewGuid());

        (await CountCodesAsync()).ShouldBe(2);
    }

    [Fact]
    public async Task A_consumed_code_cannot_still_be_holding_its_plaintext()
    {
        // code_display exists so an admin can re-read a code he has already sent by Viber without
        // killing it. The moment the code is dead the plaintext goes: the database never holds a
        // usable-looking credential that is not actually usable.
        var ex = await ShouldFailAsync(InsertCodeAsync(
            Guid.NewGuid(), consumedAt: DateTime.UtcNow, codeDisplay: "XKD4-7HMP"));

        ex.ConstraintName.ShouldBe("ck_activation_code_display_cleared");
    }

    [Fact]
    public async Task A_superseded_code_cannot_still_be_holding_its_plaintext()
    {
        var ex = await ShouldFailAsync(InsertCodeAsync(
            Guid.NewGuid(), supersededAt: DateTime.UtcNow, codeDisplay: "XKD4-7HMP"));

        ex.ConstraintName.ShouldBe("ck_activation_code_display_cleared");
    }

    [Fact]
    public async Task The_live_code_index_predicate_does_not_mention_now()
    {
        // §4 is explicit and this is the single line in the schema most likely to be "fixed" by
        // somebody who has not read that paragraph: a partial index predicate must be IMMUTABLE,
        // and now() is not, so adding expiry here does not merely bend a rule — Postgres refuses
        // the index outright. Expiry is checked at activation time instead.
        //
        // Read back out of the catalogue rather than out of the configuration class, because what
        // matters is the predicate the database actually has.
        await using var db = App.CreateDbContext(companyId: null);

        var definitions = await db.Database
            .SqlQueryRaw<string>(
                """
                SELECT indexdef AS "Value" FROM pg_indexes
                WHERE tablename = 'activation_code' AND indexname = 'ux_activation_code_live'
                """)
            .ToListAsync(Ct);

        var indexDefinition = definitions.ShouldHaveSingleItem();
        indexDefinition.ShouldContain("consumed_at IS NULL");
        indexDefinition.ShouldContain("superseded_at IS NULL");
        indexDefinition.ShouldNotContain("now(");
        indexDefinition.ShouldNotContain("expires_at");
    }

    // ------------------------------------------------------------ arrange helpers

    private async Task InsertUserAsync(
        string role,
        Guid? companyId,
        string? username,
        string? email,
        string? passwordHash = null)
    {
        await using var db = App.CreateDbContext(companyId: null);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO app_user
                 (id, company_id, role, username, display_name, email, password_hash, language,
                  created_at)
             VALUES ({Guid.NewGuid()}, {companyId}, {role}, {username}, {"Test Osoba"}, {email},
                     {passwordHash}, 'sr', {DateTime.UtcNow})
             """,
            Ct);
    }

    private async Task InsertDeviceAsync(Guid id, Guid companyId, Guid userId, string tokenHash)
    {
        await using var db = App.CreateDbContext(companyId: null);

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO device (id, company_id, user_id, name, token_hash, created_at)
             VALUES ({id}, {companyId}, {userId}, {"Telefon"}, {tokenHash}, {DateTime.UtcNow})
             """,
            Ct);
    }

    private async Task InsertCodeAsync(
        Guid id,
        DateTime? consumedAt = null,
        DateTime? supersededAt = null,
        string? codeDisplay = "XKD4-7HMP")
    {
        await using var db = App.CreateDbContext(companyId: null);
        var now = DateTime.UtcNow;

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO activation_code
                 (id, company_id, user_id, created_by_user_id, code_hash, code_display,
                  created_at, expires_at, consumed_at, consumed_device_id, superseded_at)
             VALUES ({id}, {TestIds.CompanyA}, {TestIds.WorkerA}, {TestIds.WorkerA},
                     {new string('a', 64)}, {codeDisplay}, {now}, {now.AddDays(7)},
                     {consumedAt}, NULL, {supersededAt})
             """,
            Ct);
    }

    private static string FixtureDeviceTokenHash() =>
        Teren.Core.Identity.CredentialTokens.Hash(TerenTestApp.DeviceToken);

    private async Task<int> CountUsersAsync(string sql)
    {
        await using var db = App.CreateDbContext(companyId: null);

        var counts = await db.Database
            .SqlQueryRaw<int>(sql)
            .ToListAsync(Ct);

        return counts.Single();
    }

    private async Task<int> CountCodesAsync()
    {
        await using var db = App.CreateDbContext(companyId: null);

        var counts = await db.Database
            .SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM activation_code")
            .ToListAsync(Ct);

        return counts.Single();
    }

    private static async Task<PostgresException> ShouldFailAsync(Task attempt) =>
        await Should.ThrowAsync<PostgresException>(async () => await attempt);
}
