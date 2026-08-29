using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations;

public sealed class EntryConfiguration : IEntityTypeConfiguration<Entry>
{
    public void Configure(EntityTypeBuilder<Entry> builder)
    {
        builder.ToTable("entry", table =>
        {
            table.HasCheckConstraint(
                "ck_entry_status",
                "status IN ('received','processing','awaiting_confirmation'," +
                "'needs_review','confirmed','reported')");
            // schema_version is mandatory in both JSONB shapes so they can evolve per trade
            // without a migration (jsonb_exists = the ? operator, spelled out to avoid
            // parameter-placeholder confusion in tooling).
            table.HasCheckConstraint(
                "ck_entry_structure_schema_version",
                "structure IS NULL OR jsonb_exists(structure, 'schema_version')");
            table.HasCheckConstraint(
                "ck_entry_corrected_schema_version",
                "corrected IS NULL OR jsonb_exists(corrected, 'schema_version')");
        });

        builder.HasKey(e => e.Id).HasName("pk_entry");

        // The client UUID from the phone IS the primary key and the idempotency key.
        // Never generated server-side.
        builder.Property(e => e.Id).HasColumnName("id").ValueGeneratedNever();

        builder.Property(e => e.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(e => e.ProjectId).HasColumnName("project_id").IsRequired();
        builder.Property(e => e.EntryDate).HasColumnName("entry_date").IsRequired();
        builder.Property(e => e.Status)
            .HasColumnName("status")
            .HasConversion(StatusConverters.EntryStatus)
            .IsRequired();
        builder.Property(e => e.RawTranscript).HasColumnName("raw_transcript");
        builder.Property(e => e.Structure).HasColumnName("structure").HasColumnType("jsonb");
        builder.Property(e => e.Corrected).HasColumnName("corrected").HasColumnType("jsonb");
        builder.Property(e => e.Weather).HasColumnName("weather").HasColumnType("jsonb");
        builder.Property(e => e.Latitude).HasColumnName("latitude");
        builder.Property(e => e.Longitude).HasColumnName("longitude");
        builder.Property(e => e.GpsAccuracyM).HasColumnName("gps_accuracy_m");
        builder.Property(e => e.SupersedesEntryId).HasColumnName("supersedes_entry_id");
        builder.Property(e => e.DeviceId).HasColumnName("device_id");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(e => e.ReceivedAt).HasColumnName("received_at");
        builder.Property(e => e.ConfirmedAt).HasColumnName("confirmed_at");
        builder.Property(e => e.ReportedAt).HasColumnName("reported_at");
        builder.Property(e => e.FailureReason).HasColumnName("failure_reason");

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(e => e.CompanyId)
            .HasConstraintName("fk_entry_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Project>()
            .WithMany()
            .HasForeignKey(e => e.ProjectId)
            .HasConstraintName("fk_entry_project")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Entry>()
            .WithMany()
            .HasForeignKey(e => e.SupersedesEntryId)
            .HasConstraintName("fk_entry_supersedes_entry")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(e => new { e.ProjectId, e.EntryDate })
            .IsDescending(false, true)
            .HasDatabaseName("ix_entry_project_id_entry_date");

        // For the Hangfire job sweeper.
        builder.HasIndex(e => e.Status).HasDatabaseName("ix_entry_status");

        builder.HasIndex(e => e.CompanyId).HasDatabaseName("ix_entry_company_id");
        builder.HasIndex(e => e.SupersedesEntryId).HasDatabaseName("ix_entry_supersedes_entry_id");
    }
}
