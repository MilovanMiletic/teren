using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
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
    }
}
