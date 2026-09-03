using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Platform;
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
    /// Everything the platform path may see.
    /// <para>
    /// <b>This list went red on 2026-09-03 and was widened by three types, deliberately</b> — the
    /// visible, arguable widening the previous version of this comment said it was meant to force.
    /// <c>GET /api/platform/health</c> cannot say <em>what is failing and whose</em> without
    /// reading <c>entry</c> and <c>report</c>, and it cannot name a site without
    /// <c>project</c>. §6 admits <see cref="Project"/> by the founder's decision of 2026-08-30
    /// (<c>{id, company_id, name}</c> and nothing else); the two health rows are the narrowest
    /// thing that answers the rest.
    /// </para>
    /// <para>
    /// The claim to make out loud is therefore the narrowed one and not the old absolute:
    /// <em>Teren staff can see which companies and sites exist and what is failing; they cannot
    /// read a transcript, view a photograph, or open a report.</em>
    /// <see cref="The_platform_path_sees_four_columns_of_entry_and_four_of_report"/> is what makes
    /// the second half mechanical rather than editorial, and
    /// <see cref="Asking_the_identity_context_for_an_entry_throws"/> is unchanged.
    /// </para>
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
        // The health page's three (2026-09-03). Keyless four-column read-throughs of `entry` and
        // `report`, and the project's name. NOT Entry/Media/Report themselves — those three still
        // throw, which is the whole of layer 3.
        nameof(EntryHealthRow),
        nameof(PasswordToken),
        nameof(Project),
        nameof(ReportHealthRow),
    ];

    /// <summary>
    /// The columns of the evidence tables the platform model can reach, pinned exactly.
    ///
    /// <para>
    /// <b>This test is the price of the widening above, and it is the guard that replaces the
    /// absolute claim.</b> "There is no <c>Entry</c> in the model" was a sentence a reader could
    /// check in one line. "There is a four-column read-through of <c>entry</c>" is only as strong
    /// as the four columns, so the four are written down here: a new property on
    /// <c>EntryHealthRow</c> — <c>RawTranscript</c>, <c>Structure</c>, an object key — is mapped by
    /// convention the moment it is declared, and it turns this red rather than shipping.
    /// </para>
    /// <para>
    /// Read off the design-time model, and <b>keyed on the table name</b> rather than on the CLR
    /// type, which is what makes it exhaustive: a <em>second</em> keyless type mapped to
    /// <c>entry</c> next year is caught by the same assertion, because the question asked is "what
    /// can this model select from the table <c>entry</c>", not "what does this one class hold".
    /// </para>
    /// </summary>
    [Fact]
    public void The_platform_path_sees_four_columns_of_entry_and_four_of_report()
    {
        using var identity = App.CreateIdentityDbContext();
        var designTimeModel = identity.GetService<IDesignTimeModel>().Model;

        ColumnsOf(designTimeModel, "entry").ShouldBe(
            ["company_id", "failure_reason", "project_id", "status"],
            "the platform model's view of `entry` must stay counts and states. A transcript, a "
            + "structure or an object key here is Teren staff reading a customer's diary, and the "
            + "narrowed privacy claim (plan §6) would no longer be true.");

        ColumnsOf(designTimeModel, "report").ShouldBe(
            ["company_id", "failure_reason", "project_id", "status"],
            "`delivery_detail` and `recipients` are the two that will look harmless: the first is "
            + "the relay's own sentence about a named inbox and the second is the inbox.");

        // And the project: its name is admitted, its address and coordinates are not.
        ColumnsOf(designTimeModel, "project").ShouldBe(["company_id", "id", "name"]);
    }

    private static string[] ColumnsOf(IModel model, string table) =>
        [.. model.GetEntityTypes()
            .Where(t => t.GetTableName() == table)
            .SelectMany(t => t.GetProperties())
            .Select(p => p.GetColumnName())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(name => name, StringComparer.Ordinal)];

    /// <summary>
    /// Anti-vacuity for the pin above: it has to be capable of seeing a column that is not on the
    /// list. Proven against the <em>evidence</em> model's own mapping of the same table, which is
    /// the full set — if <c>ColumnsOf</c> were returning nothing, or ignoring the table argument,
    /// this would fail.
    /// </summary>
    [Fact]
    public void The_column_pin_can_actually_see_a_column_it_would_reject()
    {
        using var db = App.CreateDbContext(TestIds.CompanyA);
        var evidenceModel = db.GetService<IDesignTimeModel>().Model;

        var columns = ColumnsOf(evidenceModel, "entry");

        columns.ShouldContain("raw_transcript");
        columns.ShouldContain("structure");
        columns.Length.ShouldBeGreaterThan(4);
    }

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

        // The health page's three additions read tables TerenDbContext owns, so all three must be
        // excluded too. Without this, the next `dotnet ef migrations add --context
        // TerenIdentityDbContext` would emit CREATE TABLE for project and for two keyless copies
        // of entry and report — and it would only be discovered on a box that had already
        // migrated, which is every box.
        foreach (var type in new[]
        {
            typeof(Project), typeof(EntryHealthRow), typeof(ReportHealthRow),
        })
        {
            designTimeModel.GetEntityTypes().Single(t => t.ClrType == type)
                .IsTableExcludedFromMigrations().ShouldBeTrue(type.Name);
        }
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
