using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations;

public sealed class MediaConfiguration : IEntityTypeConfiguration<Media>
{
    public void Configure(EntityTypeBuilder<Media> builder)
    {
        builder.ToTable("media", table =>
        {
            table.HasCheckConstraint("ck_media_kind", "kind IN ('audio','photo')");
            table.HasCheckConstraint(
                "ck_media_upload_status",
                "upload_status IN ('pending','uploaded','verified','failed')");
        });

        builder.HasKey(m => m.Id).HasName("pk_media");

        builder.Property(m => m.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(m => m.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(m => m.EntryId).HasColumnName("entry_id").IsRequired();
        builder.Property(m => m.Kind)
            .HasColumnName("kind")
            .HasConversion(StatusConverters.MediaKind)
            .IsRequired();
        builder.Property(m => m.ObjectKey).HasColumnName("object_key").IsRequired();
        builder.Property(m => m.ContentType).HasColumnName("content_type").IsRequired();
        builder.Property(m => m.ByteSize).HasColumnName("byte_size").IsRequired();
        builder.Property(m => m.Sha256)
            .HasColumnName("sha256")
            .HasColumnType("char(64)")
            .IsRequired();
        builder.Property(m => m.CapturedAt).HasColumnName("captured_at");
        builder.Property(m => m.UploadStatus)
            .HasColumnName("upload_status")
            .HasConversion(StatusConverters.MediaUploadStatus)
            .IsRequired();
        builder.Property(m => m.CreatedAt).HasColumnName("created_at").IsRequired();

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(m => m.CompanyId)
            .HasConstraintName("fk_media_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Entry>()
            .WithMany()
            .HasForeignKey(m => m.EntryId)
            .HasConstraintName("fk_media_entry")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(m => m.EntryId).HasDatabaseName("ix_media_entry_id");
        builder.HasIndex(m => m.CompanyId).HasDatabaseName("ix_media_company_id");
        builder.HasIndex(m => m.ObjectKey).IsUnique().HasDatabaseName("ux_media_object_key");
    }
}
