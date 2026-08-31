using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations;

public sealed class CompanyConfiguration : IEntityTypeConfiguration<Company>
{
    public void Configure(EntityTypeBuilder<Company> builder)
    {
        builder.ToTable("company");
        builder.HasKey(c => c.Id).HasName("pk_company");

        builder.Property(c => c.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(c => c.Name).HasColumnName("name").IsRequired();
        builder.Property(c => c.CreatedAt).HasColumnName("created_at").IsRequired();

        // Nullable, and never backfilled: an unsuspended company is the absence of a stamp, not
        // a flag set to false. Every credential check requires it to be null, so suspending a
        // customer reaches all of his phones on their next request.
        builder.Property(c => c.SuspendedAt).HasColumnName("suspended_at");
    }
}
