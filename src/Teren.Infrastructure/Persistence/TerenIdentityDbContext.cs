using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Platform;
using Teren.Infrastructure.Persistence.Configurations;
using Teren.Infrastructure.Persistence.Configurations.Identity;

namespace Teren.Infrastructure.Persistence;

/// <summary>
/// The platform-side model: who exists, what may sign in, which phones are alive. <b>Layer 3 of
/// the four that keep a super admin away from customer evidence</b> (profile-and-identity §6).
/// <para>
/// It maps a <b>named, closed set</b> of types by calling <see cref="ModelBuilder.ApplyConfiguration"/>
/// once per type — never <c>ApplyConfigurationsFromAssembly</c>, which would drag the evidence
/// types in the moment somebody added a configuration next door. There is no
/// <c>DbSet&lt;Entry&gt;</c>, no <c>Media</c>, no <c>Report</c>, and
/// <c>db.Set&lt;Entry&gt;()</c> therefore <b>throws at runtime</b> because the type is not in the
/// model at all.
/// </para>
/// <para>
/// <b>The one qualification that sentence now needs, stated here rather than discovered.</b> The
/// health page (plan §8) cannot say what is failing without reading <c>entry</c> and
/// <c>report</c>, so this model maps <see cref="EntryHealthRow"/> and
/// <see cref="ReportHealthRow"/> — four columns each, none of them content — and
/// <see cref="Project"/> as <c>{id, company_id, name}</c>. The claim to make out loud is therefore
/// the narrowed one the founder settled on 2026-08-30: <em>Teren staff can see which companies and
/// sites exist and what is failing; they cannot read a transcript, view a photograph, or open a
/// report.</em> The three types are the whole of the widening, their CLR declarations are the
/// column allow-list, and <c>IdentityModelTests</c> pins both the set and the columns.
/// </para>
/// <para>
/// That is the property worth stating plainly: <em>"a super admin cannot read evidence"</em> stops
/// being a policy the code applies and becomes a property of the model the platform code path is
/// compiled against. Layers 1 (a route gate), 2 (a null tenant, so every evidence query filter
/// matches nothing) and 4 (the <c>IgnoreQueryFilters</c> allow-list test) arrive with D2 and D4;
/// each of the four would hold alone.
/// </para>
/// <para>
/// <b>No query filters here, and that is deliberate.</b> The credential authenticator has to read
/// <c>device</c> → <c>app_user</c> → <c>company</c> <em>before</em> any tenant is known. Doing
/// that through this context rather than through <see cref="TerenDbContext"/> is what makes
/// <c>IgnoreQueryFilters()</c> disappear from the auth path entirely — after which it appears
/// under <c>src/</c> in exactly one file, <c>DemoSeeder.cs</c>, and a test keeps it that way.
/// </para>
/// <para>
/// <b>Migrations.</b> This context owns its own history table
/// (<c>__EFMigrationsHistory_identity</c>) and its own snapshot under <c>Migrations/Identity</c>,
/// so <c>dotnet ef</c> keeps working for both models and neither can silently drift from its
/// schema. <see cref="Company"/> is mapped here but excluded from these migrations: it belongs to
/// <see cref="TerenDbContext"/>, and only one context may own a table's DDL.
/// </para>
/// </summary>
public sealed class TerenIdentityDbContext(DbContextOptions<TerenIdentityDbContext> options)
    : DbContext(options)
{
    /// <summary>The history table for this context's migrations, kept beside the model it
    /// describes so the two cannot be configured apart.</summary>
    public const string MigrationsHistoryTable = "__EFMigrationsHistory_identity";

    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<ActivationCode> ActivationCodes => Set<ActivationCode>();
    public DbSet<PasswordToken> PasswordTokens => Set<PasswordToken>();
    public DbSet<AdminSession> AdminSessions => Set<AdminSession>();
    public DbSet<AdminAudit> AdminAudits => Set<AdminAudit>();

    /// <summary>
    /// The application's own log (D5). It is mapped <b>here</b> rather than on the evidence model
    /// for one reason: the log viewer is a super-admin screen, and putting its table in this
    /// closed set is what keeps that screen compiled against a model with no <c>Entry</c> in it.
    /// </summary>
    public DbSet<AppLog> Logs => Set<AppLog>();

    /// <summary>
    /// Read-only from here: the authenticator needs <c>suspended_at</c> before a tenant exists.
    /// Nothing on the platform path writes a company row in D1.
    /// </summary>
    public DbSet<Company> Companies => Set<Company>();

    /// <summary>
    /// The customers' sites, <b>as <c>{id, company_id, name}</c> and nothing else</b>.
    /// <para>
    /// Admitted by the founder's decision of 2026-08-30 (plan §6) so the health page can say
    /// <em>which</em> site is failing rather than printing a uuid at a founder. The narrowing is
    /// mechanical, not editorial: <see cref="PlatformProjectConfiguration"/> ignores
    /// <c>address</c>, the coordinates, <c>recipients</c> and <c>vocabulary</c>, so they are not
    /// in this model and no query written against it can reach them.
    /// </para>
    /// <para>
    /// <b>Platform-only, and never materialise the entity from here.</b> Two reasons, and the
    /// second is the one that bites. First, this context carries <em>no query filters</em>
    /// (deliberately, see the note below), so a company-scoped handler reading this set would see
    /// every customer's sites; the platform is the only caller that is supposed to. Second, a
    /// <see cref="Project"/> read through this model comes back with <c>Address</c> null and
    /// <c>ReportLanguage</c>/<c>TimeZone</c> at their CLR defaults — <b>"absent" is
    /// indistinguishable from "not loaded"</b>, and code downstream cannot tell that it was never
    /// asked for. That is precisely the shape of the F10 defect, where a screen printed "no address
    /// on file" above a man's name for a value it had simply not fetched. Project queries here
    /// project to the three columns they need and never hand the entity onward.
    /// </para>
    /// </summary>
    public DbSet<Project> Projects => Set<Project>();

    /// <summary>
    /// The two read-throughs the health page needs, and the closest this model comes to evidence.
    /// <para>
    /// <b>Read <see cref="EntryHealthRow"/>'s own summary before touching either.</b> Each maps
    /// four columns of a table the evidence model owns — company, site, status, failure reason —
    /// and the CLR type is the whole of the allow-list, so there is no transcript, structure or
    /// object key to select. <c>db.Set&lt;Entry&gt;()</c>, <c>Media</c> and <c>Report</c> still
    /// throw here, which is the sentence layer 3 has always made.
    /// </para>
    /// </summary>
    public DbSet<EntryHealthRow> EntryHealth => Set<EntryHealthRow>();

    /// <inheritdoc cref="EntryHealth"/>
    public DbSet<ReportHealthRow> ReportHealth => Set<ReportHealthRow>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new AppUserConfiguration());
        modelBuilder.ApplyConfiguration(new DeviceConfiguration());
        modelBuilder.ApplyConfiguration(new ActivationCodeConfiguration());
        modelBuilder.ApplyConfiguration(new PasswordTokenConfiguration());
        modelBuilder.ApplyConfiguration(new AdminSessionConfiguration());
        modelBuilder.ApplyConfiguration(new AdminAuditConfiguration());
        modelBuilder.ApplyConfiguration(new AppLogConfiguration());

        // Company is shared with TerenDbContext, which owns its DDL. Mapping it without excluding
        // it would make both contexts try to create the same table.
        modelBuilder.ApplyConfiguration(new CompanyConfiguration());
        modelBuilder.Entity<Company>().ToTable("company", t => t.ExcludeFromMigrations());

        // The health page's three additions (plan §6/§8). All three read tables TerenDbContext
        // owns, so all three exclude themselves from this history — the exclusion is inside each
        // configuration rather than repeated here, because a keyless type mapped to `entry`
        // without it would make the next identity migration try to create a second one.
        modelBuilder.ApplyConfiguration(new PlatformProjectConfiguration());
        modelBuilder.ApplyConfiguration(new EntryHealthRowConfiguration());
        modelBuilder.ApplyConfiguration(new ReportHealthRowConfiguration());
    }
}
