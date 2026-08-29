using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations;

public sealed class ReportConfiguration : IEntityTypeConfiguration<Report>
{
    public void Configure(EntityTypeBuilder<Report> builder)
    {
        builder.ToTable("report", table =>
            table.HasCheckConstraint("ck_report_kind", "kind IN ('daily','weekly')"));

        builder.HasKey(r => r.Id).HasName("pk_report");

        builder.Property(r => r.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(r => r.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(r => r.ProjectId).HasColumnName("project_id").IsRequired();
        builder.Property(r => r.Kind)
            .HasColumnName("kind")
            .HasConversion(StatusConverters.ReportKind)
            .IsRequired();
        builder.Property(r => r.PeriodStart).HasColumnName("period_start").IsRequired();
        builder.Property(r => r.PeriodEnd).HasColumnName("period_end").IsRequired();
        builder.Property(r => r.PdfObjectKey).HasColumnName("pdf_object_key");
        builder.Property(r => r.Recipients).HasColumnName("recipients").HasColumnType("jsonb");
        builder.Property(r => r.SentAt).HasColumnName("sent_at");
        builder.Property(r => r.CreatedAt).HasColumnName("created_at").IsRequired();

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(r => r.CompanyId)
            .HasConstraintName("fk_report_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Project>()
            .WithMany()
            .HasForeignKey(r => r.ProjectId)
            .HasConstraintName("fk_report_project")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(r => r.CompanyId).HasDatabaseName("ix_report_company_id");
        builder.HasIndex(r => new { r.ProjectId, r.PeriodStart })
            .IsDescending(false, true)
            .HasDatabaseName("ix_report_project_id_period_start");
    }
}
