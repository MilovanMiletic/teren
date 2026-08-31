using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <c>admin_session</c>. Like <c>password_token</c> it carries no <c>company_id</c>: a super admin
/// has none, and the owning tenant is whatever <c>user_id</c> points at.
/// </summary>
public sealed class AdminSessionConfiguration : IEntityTypeConfiguration<AdminSession>
{
    public void Configure(EntityTypeBuilder<AdminSession> builder)
    {
        builder.ToTable("admin_session");
        builder.HasKey(s => s.Id).HasName("pk_admin_session");

        builder.Property(s => s.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(s => s.UserId).HasColumnName("user_id").IsRequired();
        builder.Property(s => s.TokenHash)
            .HasColumnName("token_hash")
            .HasColumnType($"char({CredentialTokens.HashLength})")
            .IsRequired();
        builder.Property(s => s.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(s => s.LastSeenAt).HasColumnName("last_seen_at").IsRequired();
        builder.Property(s => s.ExpiresAt).HasColumnName("expires_at").IsRequired();
        builder.Property(s => s.RevokedAt).HasColumnName("revoked_at");

        builder.HasOne<AppUser>()
            .WithMany()
            .HasForeignKey(s => s.UserId)
            .HasConstraintName("fk_admin_session_user")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(s => s.TokenHash).IsUnique().HasDatabaseName("ux_admin_session_token_hash");
        builder.HasIndex(s => s.UserId).HasDatabaseName("ix_admin_session_user_id");
    }
}
