using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;
using Teren.Core.Reporting;

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
        // Deliberately the same shape as report_language above: both answer "whose report is
        // this", and both belong to the project rather than to a device. NOT NULL with a default
        // so no project can exist without a zone — an unset zone means a report that cannot print
        // a timestamp at all, because ReportTimeZone refuses to guess one.
        builder.Property(p => p.TimeZone)
            .HasColumnName("time_zone")
            .IsRequired()
            .HasDefaultValue(ReportTimeZone.Default);

        builder.Property(p => p.CreatedAt).HasColumnName("created_at").IsRequired();

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(p => p.CompanyId)
            .HasConstraintName("fk_project_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(p => p.CompanyId).HasDatabaseName("ix_project_company_id");
    }
}
