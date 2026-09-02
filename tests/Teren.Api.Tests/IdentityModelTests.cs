using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Tests;

/// <summary>
/// <b>Layer 3 of the four that keep a super admin away from customer evidence</b>
/// (profile-and-identity §6): the platform code path is compiled against a model that does not
/// contain <c>Entry</c>, <c>Media</c> or <c>Report</c> at all.
/// <para>
/// That is what turns "a super admin cannot read evidence" from a policy the code applies into a
/// property of the model. The other three layers arrive later — the route gate and the null tenant
/// at D2, and the <c>IgnoreQueryFilters</c> allow-list, which is already enforced by
/// <see cref="QueryFilterAllowListTests"/>. Each would hold alone.
/// </para>
/// <para>
/// Both models are asserted as <b>closed sets</b>, in both directions. The reverse direction is not
/// symmetry for its own sake: <c>TerenDbContext</c> used to call
/// <c>ApplyConfigurationsFromAssembly</c>, and the identity configurations live in the same
/// assembly, so a by-assembly scan would have pulled <c>app_user</c> and <c>device</c> into the
/// evidence model — and into its migrations — the moment one was added.
/// </para>
/// </summary>
public sealed class IdentityModelTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>
    /// Everything the platform path may see. <c>Project</c> is deliberately <b>not</b> here yet:
    /// §6 admits it by the founder's decision of 2026-08-30 so the platform health page can name a
    /// site, but nothing reads it before D4, and adding it there is meant to be a visible,
    /// deliberate widening that turns this list red rather than an afternoon's convenience.
    /// </summary>
    private static readonly string[] IdentityModelTypes =
    [
        nameof(ActivationCode),
        nameof(AdminAudit),
        nameof(AdminSession),
        // D5. The log stream is mapped here rather than on the evidence model on purpose: it is
        // what keeps the super admin's log viewer compiled against a context with no Entry in it.
        nameof(AppLog),
        nameof(AppUser),
        nameof(Company),
        nameof(Device),
        nameof(PasswordToken),
    ];

    private static readonly string[] EvidenceModelTypes =
    [
        nameof(Company),
        nameof(Entry),
        nameof(Media),
        nameof(Project),
        nameof(Report),
    ];

    [Fact]
    public void The_identity_model_contains_no_evidence_types()
    {
        // THE MUTATION TARGET. Adding `DbSet<Entry> Entries => Set<Entry>()` plus its
        // configuration to TerenIdentityDbContext must turn this red.
        using var identity = App.CreateIdentityDbContext();

        var mapped = identity.Model.GetEntityTypes()
            .Select(t => t.ClrType.Name)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        mapped.ShouldBe(IdentityModelTypes);

        mapped.ShouldNotContain(nameof(Entry));
        mapped.ShouldNotContain(nameof(Media));
        mapped.ShouldNotContain(nameof(Report));
    }

    [Fact]
    public void Asking_the_identity_context_for_an_entry_throws()
    {
        // Not "returns nothing" — throws, because the type is not in the model. A platform
        // endpoint that reached for evidence would fail loudly at the seam rather than quietly
        // return an empty page that somebody later "fixes" by widening a filter.
        using var identity = App.CreateIdentityDbContext();

        // EF defers the check to first use rather than to Set<T>() itself, so the assertion has
        // to touch the set. That is the realistic shape anyway: what must fail is a platform
        // endpoint trying to READ evidence, and it fails before a single row is fetched because
        // there is no entity type to build a query from.
        Should.Throw<InvalidOperationException>(() => identity.Set<Entry>().FirstOrDefault())
            .Message.ShouldContain(nameof(Entry));
        Should.Throw<InvalidOperationException>(() => identity.Set<Media>().FirstOrDefault());
        Should.Throw<InvalidOperationException>(() => identity.Set<Report>().FirstOrDefault());
    }

    [Fact]
    public void The_evidence_model_contains_no_identity_types()
    {
        // The reverse closed set. If app_user or device appeared here they would arrive with a
        // tenant query filter over user rows on the hottest path in the system, and the evidence
        // context would gain a db.Set<AppUser>() that nothing should ever want.
        using var db = App.CreateDbContext(TestIds.CompanyA);

        var mapped = db.Model.GetEntityTypes()
            .Select(t => t.ClrType.Name)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        mapped.ShouldBe(EvidenceModelTypes);
    }

    [Fact]
    public void The_identity_model_carries_no_query_filters()
    {
        // This is what lets DbCredentialAuthenticator resolve a token before any tenant is known
        // without reaching for IgnoreQueryFilters — and therefore what leaves that call in exactly
        // one file under src/.
        using var identity = App.CreateIdentityDbContext();

        foreach (var entityType in identity.Model.GetEntityTypes())
        {
            entityType.GetDeclaredQueryFilters().ShouldBeEmpty(entityType.ClrType.Name);
        }
    }

    [Fact]
    public void The_evidence_model_still_filters_every_tenant_owned_type()
    {
        // The identity split must not have cost layer 2 anything. Company is included: a caller
        // may only ever see his own.
        using var db = App.CreateDbContext(TestIds.CompanyA);

        foreach (var name in EvidenceModelTypes)
        {
            var entityType = db.Model.GetEntityTypes().Single(t => t.ClrType.Name == name);

            entityType.GetDeclaredQueryFilters().ShouldNotBeEmpty(name);
        }
    }

    [Fact]
    public void Company_is_shared_but_owned_by_exactly_one_migration_history()
    {
        // Two contexts map the company table; only one may issue its DDL. Without the exclusion
        // both would try to CREATE TABLE company and the second migrate would fail on a box that
        // had already run the first.
        // Read off the DESIGN-TIME model: ExcludeFromMigrations is a migrations-only annotation and
        // is deliberately absent from the runtime model, which EF trims to what queries need.
        using var identity = App.CreateIdentityDbContext();
        var designTimeModel = identity.GetService<IDesignTimeModel>().Model;

        var company = designTimeModel.GetEntityTypes().Single(t => t.ClrType == typeof(Company));
        company.IsTableExcludedFromMigrations().ShouldBeTrue();

        var device = designTimeModel.GetEntityTypes().Single(t => t.ClrType == typeof(Device));
        device.IsTableExcludedFromMigrations().ShouldBeFalse();
    }

    [Fact]
    public async Task Both_migration_histories_are_applied_and_distinct()
    {
        // A second history table is the cost of the split; it is only safe if `migrate` actually
        // runs both. The test database is built by the fixture the same way Program.cs builds a
        // real one, so an unapplied identity history would fail here rather than at a deploy.
        await using var db = App.CreateDbContext(companyId: null);

        var tables = await db.Database
            .SqlQueryRaw<string>(
                """
                SELECT tablename AS "Value" FROM pg_tables
                WHERE schemaname = 'public' AND tablename LIKE '\_\_EFMigrationsHistory%'
                """)
            .ToListAsync(Ct);

        tables.ShouldContain("__EFMigrationsHistory");
        tables.ShouldContain(TerenIdentityDbContext.MigrationsHistoryTable);
    }
}
