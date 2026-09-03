using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;
using Teren.Core.Platform;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <see cref="Project"/> as the platform may see it: <c>{id, company_id, name}</c> and nothing
/// else.
///
/// <para>
/// A second configuration for a type the evidence model already maps, deliberately — not a reuse
/// of <see cref="ProjectConfiguration"/>. Reusing it would put <c>address</c>,
/// <c>latitude</c>/<c>longitude</c>, <c>recipients</c> and <c>vocabulary</c> in the platform
/// model, and "the DTO does not expose them" would be the only thing standing between Teren staff
/// and a customer's site addresses. Here the columns are not in the model at all, so no query the
/// platform path can write will select one, and a <c>Select</c> that named
/// <c>p.Address</c> would not compile against this context's model — it would throw at
/// translation. Plan §6: <em>project names are admitted by the founder's decision of 2026-08-30
/// and everything else about a project is not.</em>
/// </para>
///
/// <para>
/// <b>The unmapped properties read as <em>absent</em>, not as <em>unfetched</em>, and callers have
/// to know it.</b> A <see cref="Project"/> materialised from this model carries <c>Address</c>
/// null and <c>ReportLanguage</c>/<c>TimeZone</c> at their CLR defaults, and nothing downstream
/// can tell that from a site that genuinely has no address — the F10 defect, where a screen
/// printed "no address on file" for a value it had never asked for. So the platform's project
/// queries project to <c>{id, company_id, name}</c> and the entity is never handed onward.
/// </para>
///
/// <para>
/// <b>Excluded from this context's migrations</b>, exactly as <see cref="Company"/> is, and for
/// the same reason: <c>TerenDbContext</c> owns the DDL of <c>project</c>, and two contexts both
/// issuing <c>CREATE TABLE project</c> would make the second <c>migrate</c> fail on any box that
/// had run the first. <c>IdentityModelTests</c> asserts the exclusion.
/// </para>
/// </summary>
public sealed class PlatformProjectConfiguration : IEntityTypeConfiguration<Project>
{
    public void Configure(EntityTypeBuilder<Project> builder)
    {
        builder.ToTable("project", t => t.ExcludeFromMigrations());
        builder.HasKey(p => p.Id).HasName("pk_project");

        builder.Property(p => p.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(p => p.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(p => p.Name).HasColumnName("name").IsRequired();

        // The exclusions, named one by one so that removing one is a visible line in a diff
        // rather than the absence of a line. `Ignore` and not `HasColumnName`: an ignored property
        // is not in the model, so it cannot be projected, filtered on, or ordered by.
        builder.Ignore(p => p.Address);
        builder.Ignore(p => p.Latitude);
        builder.Ignore(p => p.Longitude);
        builder.Ignore(p => p.Recipients);
        builder.Ignore(p => p.Vocabulary);
        builder.Ignore(p => p.ReportLanguage);
        builder.Ignore(p => p.TimeZone);
        builder.Ignore(p => p.CreatedAt);
    }
}

/// <summary>
/// <see cref="EntryHealthRow"/> over the <c>entry</c> table: keyless, four columns, aggregate-only
/// by every caller.
/// <para>
/// Keyless because nothing identifies one of these rows — they exist to be grouped, and giving
/// them a key would invite EF to track and cache what is a read-through of somebody else's table.
/// Excluded from migrations because <c>TerenDbContext</c> owns <c>entry</c>'s DDL; without the
/// exclusion the next identity migration would try to create a second, keyless <c>entry</c> table.
/// </para>
/// </summary>
public sealed class EntryHealthRowConfiguration : IEntityTypeConfiguration<EntryHealthRow>
{
    public void Configure(EntityTypeBuilder<EntryHealthRow> builder)
    {
        builder.HasNoKey();
        builder.ToTable("entry", t => t.ExcludeFromMigrations());

        builder.Property(r => r.CompanyId).HasColumnName("company_id");
        builder.Property(r => r.ProjectId).HasColumnName("project_id");
        // The same converter the evidence model uses, so the stored text and the status this
        // groups by are the same string by construction (see StatusConverters).
        builder.Property(r => r.Status)
            .HasColumnName("status")
            .HasConversion(StatusConverters.EntryStatus);
        builder.Property(r => r.FailureReason).HasColumnName("failure_reason");
    }
}

/// <inheritdoc cref="EntryHealthRowConfiguration"/>
public sealed class ReportHealthRowConfiguration : IEntityTypeConfiguration<ReportHealthRow>
{
    public void Configure(EntityTypeBuilder<ReportHealthRow> builder)
    {
        builder.HasNoKey();
        builder.ToTable("report", t => t.ExcludeFromMigrations());

        builder.Property(r => r.CompanyId).HasColumnName("company_id");
        builder.Property(r => r.ProjectId).HasColumnName("project_id");
        builder.Property(r => r.Status)
            .HasColumnName("status")
            .HasConversion(StatusConverters.ReportStatus);
        builder.Property(r => r.FailureReason).HasColumnName("failure_reason");
    }
}
