using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations;

public sealed class ReportConfiguration : IEntityTypeConfiguration<Report>
{
    public void Configure(EntityTypeBuilder<Report> builder)
    {
        builder.ToTable("report", table =>
        {
            table.HasCheckConstraint("ck_report_kind", "kind IN ('daily','weekly')");
            table.HasCheckConstraint(
                "ck_report_status", "status IN ('sending','sent','failed')");
            // The honesty rule, in the schema rather than in a comment: sent_at is stamped only
            // by a relay taking custody, so it exists exactly when the status says it does.
            table.HasCheckConstraint(
                "ck_report_sent_at",
                "(status = 'sent') = (sent_at IS NOT NULL)");
        });

        builder.HasKey(r => r.Id).HasName("pk_report");

        builder.Property(r => r.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(r => r.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(r => r.ProjectId).HasColumnName("project_id").IsRequired();
        builder.Property(r => r.EntryId).HasColumnName("entry_id");
        builder.Property(r => r.Kind)
            .HasColumnName("kind")
            .HasConversion(StatusConverters.ReportKind)
            .IsRequired();
        builder.Property(r => r.PeriodStart).HasColumnName("period_start").IsRequired();
        builder.Property(r => r.PeriodEnd).HasColumnName("period_end").IsRequired();
        builder.Property(r => r.PdfObjectKey).HasColumnName("pdf_object_key");
        builder.Property(r => r.PdfSha256).HasColumnName("pdf_sha256").HasMaxLength(64);
        builder.Property(r => r.Recipients).HasColumnName("recipients").HasColumnType("jsonb");
        builder.Property(r => r.Status)
            .HasColumnName("status")
            .HasConversion(StatusConverters.ReportStatus)
            .IsRequired();
        builder.Property(r => r.SentAt).HasColumnName("sent_at");
        builder.Property(r => r.DeliveryDetail).HasColumnName("delivery_detail");
        builder.Property(r => r.Attempts).HasColumnName("attempts").IsRequired();
        builder.Property(r => r.AttemptStartedAt).HasColumnName("attempt_started_at");
        builder.Property(r => r.FailureReason).HasColumnName("failure_reason");
        builder.Property(r => r.CreatedAt).HasColumnName("created_at").IsRequired();

        builder.HasOne<Entry>()
            .WithMany()
            .HasForeignKey(r => r.EntryId)
            .HasConstraintName("fk_report_entry")
            .OnDelete(DeleteBehavior.Restrict);

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

        // One entry, one report — and this index is what enforces it rather than the job being
        // careful. It is the claim two concurrent report passes contend for: the insert either
        // wins or raises a unique violation, and the loser sends nothing. Partial, because a
        // weekly recap (ROADMAP C6) covers a period and leaves entry_id null; without the
        // predicate a second period report would collide with the first on NULL in some engines
        // and, more importantly, the intent would be unreadable.
        builder.HasIndex(r => r.EntryId)
            .IsUnique()
            .HasFilter("entry_id IS NOT NULL")
            .HasDatabaseName("ux_report_entry_id");

        builder.HasIndex(r => new { r.ProjectId, r.PeriodStart })
            .IsDescending(false, true)
            .HasDatabaseName("ix_report_project_id_period_start");
    }
}
