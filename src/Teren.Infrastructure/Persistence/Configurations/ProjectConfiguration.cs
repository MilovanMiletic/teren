using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations;

public sealed class ProjectConfiguration : IEntityTypeConfiguration<Project>
{
    public void Configure(EntityTypeBuilder<Project> builder)
    {
        builder.ToTable("project");
        builder.HasKey(p => p.Id).HasName("pk_project");

        builder.Property(p => p.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(p => p.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(p => p.Name).HasColumnName("name").IsRequired();
        builder.Property(p => p.Address).HasColumnName("address");
        builder.Property(p => p.Latitude).HasColumnName("latitude");
        builder.Property(p => p.Longitude).HasColumnName("longitude");
        builder.Property(p => p.Recipients).HasColumnName("recipients").HasColumnType("jsonb");
        builder.Property(p => p.Vocabulary).HasColumnName("vocabulary").HasColumnType("jsonb");
        builder.Property(p => p.ReportLanguage)
            .HasColumnName("report_language")
            .IsRequired()
            .HasDefaultValue("sr");
        builder.Property(p => p.CreatedAt).HasColumnName("created_at").IsRequired();

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(p => p.CompanyId)
            .HasConstraintName("fk_project_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(p => p.CompanyId).HasDatabaseName("ix_project_company_id");
    }
}
