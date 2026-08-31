using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <c>admin_audit</c>. <c>detail</c> is JSONB and is mapped as a string, boring on purpose and for
/// the same reason the evidence JSONB columns are: the server treats it as an opaque payload and
/// Postgres validates what must be validated.
/// </summary>
public sealed class AdminAuditConfiguration : IEntityTypeConfiguration<AdminAudit>
{
    public void Configure(EntityTypeBuilder<AdminAudit> builder)
    {
        builder.ToTable("admin_audit");
        builder.HasKey(a => a.Id).HasName("pk_admin_audit");

        builder.Property(a => a.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(a => a.ActorUserId).HasColumnName("actor_user_id").IsRequired();
        builder.Property(a => a.Action).HasColumnName("action").IsRequired();
        builder.Property(a => a.SubjectType).HasColumnName("subject_type").IsRequired();
        builder.Property(a => a.SubjectId).HasColumnName("subject_id");
        builder.Property(a => a.CompanyId).HasColumnName("company_id");
        builder.Property(a => a.Detail).HasColumnName("detail").HasColumnType("jsonb");
        builder.Property(a => a.CreatedAt).HasColumnName("created_at").IsRequired();

        builder.HasOne<AppUser>()
            .WithMany()
            .HasForeignKey(a => a.ActorUserId)
            .HasConstraintName("fk_admin_audit_actor_user")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(a => a.CompanyId)
            .HasConstraintName("fk_admin_audit_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(a => a.CompanyId).HasDatabaseName("ix_admin_audit_company_id");
        builder.HasIndex(a => a.ActorUserId).HasDatabaseName("ix_admin_audit_actor_user_id");
        builder.HasIndex(a => a.CreatedAt)
            .IsDescending()
            .HasDatabaseName("ix_admin_audit_created_at");
    }
}
