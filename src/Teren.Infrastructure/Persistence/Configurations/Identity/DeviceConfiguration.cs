using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <c>device</c>. <c>ux_device_token_hash</c> is not an ordinary index — it <b>is</b> the auth
/// path, the single seek every authenticated request makes.
/// <para>
/// §12 of ARCHITECTURE sketched a <c>project_id</c> here, from the old C5 design where a join code
/// bound a device to a project. It is deliberately dropped: the founder's flow binds a <em>person
/// to a company</em> and the project picker is a live control, so a nullable column nothing reads
/// would be exactly the speculative schema that section itself argues against.
/// </para>
/// </summary>
public sealed class DeviceConfiguration : IEntityTypeConfiguration<Device>
{
    public void Configure(EntityTypeBuilder<Device> builder)
    {
        builder.ToTable("device");
        builder.HasKey(d => d.Id).HasName("pk_device");

        builder.Property(d => d.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(d => d.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(d => d.UserId).HasColumnName("user_id").IsRequired();
        builder.Property(d => d.Name).HasColumnName("name").IsRequired();
        builder.Property(d => d.TokenHash)
            .HasColumnName("token_hash")
            .HasColumnType($"char({CredentialTokens.HashLength})")
            .IsRequired();
        builder.Property(d => d.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(d => d.LastSeenAt).HasColumnName("last_seen_at");
        builder.Property(d => d.RevokedAt).HasColumnName("revoked_at");
        builder.Property(d => d.RevokedByUserId).HasColumnName("revoked_by_user_id");

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(d => d.CompanyId)
            .HasConstraintName("fk_device_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<AppUser>()
            .WithMany()
            .HasForeignKey(d => d.UserId)
            .HasConstraintName("fk_device_user")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<AppUser>()
            .WithMany()
            .HasForeignKey(d => d.RevokedByUserId)
            .HasConstraintName("fk_device_revoked_by_user")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(d => d.TokenHash).IsUnique().HasDatabaseName("ux_device_token_hash");
        builder.HasIndex(d => d.CompanyId).HasDatabaseName("ix_device_company_id");
        builder.HasIndex(d => d.UserId).HasDatabaseName("ix_device_user_id");
        builder.HasIndex(d => d.RevokedByUserId)
            .HasDatabaseName("ix_device_revoked_by_user_id");
    }
}
