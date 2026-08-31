using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Tenancy;
using Teren.Infrastructure.Persistence.Configurations;

namespace Teren.Infrastructure.Persistence;

public sealed class TerenDbContext(DbContextOptions<TerenDbContext> options, TenantContext tenant)
    : DbContext(options)
{
    private readonly TenantContext _tenant = tenant;

    public DbSet<Company> Companies => Set<Company>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<Entry> Entries => Set<Entry>();
    public DbSet<Media> Media => Set<Media>();
    public DbSet<Report> Reports => Set<Report>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Named one by one, never ApplyConfigurationsFromAssembly. The identity model
        // (TerenIdentityDbContext) lives in the same assembly, and a by-assembly scan would pull
        // app_user, device and the rest into the evidence model — and into its migrations — the
        // moment a configuration was added next door. Both contexts are closed sets, and a test
        // asserts the composition of each; this is layer 3 of profile-and-identity §6 read in the
        // other direction.
        modelBuilder.ApplyConfiguration(new CompanyConfiguration());
        modelBuilder.ApplyConfiguration(new ProjectConfiguration());
        modelBuilder.ApplyConfiguration(new EntryConfiguration());
        modelBuilder.ApplyConfiguration(new MediaConfiguration());
        modelBuilder.ApplyConfiguration(new ReportConfiguration());

        // Tenant scoping is automatic and deny-by-default: correctness never depends on a
        // handler remembering a Where clause. _tenant.CompanyId is read per query, so setting
        // it after DbContext construction works.
        modelBuilder.Entity<Company>().HasQueryFilter(c => c.Id == _tenant.CompanyId);
        modelBuilder.Entity<Project>().HasQueryFilter(p => p.CompanyId == _tenant.CompanyId);
        modelBuilder.Entity<Entry>().HasQueryFilter(e => e.CompanyId == _tenant.CompanyId);
        modelBuilder.Entity<Media>().HasQueryFilter(m => m.CompanyId == _tenant.CompanyId);
        modelBuilder.Entity<Report>().HasQueryFilter(r => r.CompanyId == _tenant.CompanyId);
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        EnforceEntryImmutability();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(
        bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        EnforceEntryImmutability();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }

    /// <summary>
    /// Application-side half of the immutability guarantee (the other half is the Postgres
    /// trigger <c>entry_guard_update/delete</c>): a reported entry never changes, and the raw
    /// transcript is write-once. Corrections are new entries via supersedes_entry_id.
    /// </summary>
    private void EnforceEntryImmutability()
    {
        foreach (var tracked in ChangeTracker.Entries<Entry>())
        {
            if (tracked.State is not (EntityState.Modified or EntityState.Deleted))
            {
                continue;
            }

            var reportedAt = tracked.OriginalValues.GetValue<DateTime?>(
                nameof(Core.Entities.Entry.ReportedAt));
            if (reportedAt is not null)
            {
                throw new InvalidOperationException(
                    $"Entry {tracked.Entity.Id} is immutable: it was reported at {reportedAt:O}. " +
                    "Create a correction entry with SupersedesEntryId instead.");
            }

            if (tracked.State is EntityState.Modified)
            {
                var originalTranscript =
                    tracked.OriginalValues.GetValue<string?>(
                        nameof(Core.Entities.Entry.RawTranscript));
                if (originalTranscript is not null
                    && originalTranscript != tracked.Entity.RawTranscript)
                {
                    throw new InvalidOperationException(
                        $"Entry {tracked.Entity.Id}: raw_transcript is evidence and write-once; " +
                        "it is never edited or overwritten.");
                }
            }
        }
    }
}
