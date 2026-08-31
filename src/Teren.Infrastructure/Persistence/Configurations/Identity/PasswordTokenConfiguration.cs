using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <c>password_token</c>: invite and reset, one mechanism.
/// <para>
/// Note there is no <c>company_id</c> here, and that is correct rather than an omission — a super
/// admin has no company, so the owning tenant is whatever <c>user_id</c> points at. Anything that
/// needs to scope these rows to a company goes through <c>app_user</c>, and
/// <c>DemoReset</c> does exactly that.
/// </para>
/// </summary>
public sealed class PasswordTokenConfiguration : IEntityTypeConfiguration<PasswordToken>
{
    public void Configure(EntityTypeBuilder<PasswordToken> builder)
    {
        builder.ToTable("password_token", table =>
            table.HasCheckConstraint(
                "ck_password_token_purpose",
                $"purpose IN ({Sql.Quoted(PasswordTokenPurposeNames.All)})"));

        builder.HasKey(t => t.Id).HasName("pk_password_token");

        builder.Property(t => t.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(t => t.UserId).HasColumnName("user_id").IsRequired();
        builder.Property(t => t.Purpose)
            .HasColumnName("purpose")
            .HasConversion(StatusConverters.PasswordTokenPurpose)
            .IsRequired();
        builder.Property(t => t.TokenHash)
            .HasColumnName("token_hash")
            .HasColumnType($"char({CredentialTokens.HashLength})")
            .IsRequired();
        builder.Property(t => t.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(t => t.ExpiresAt).HasColumnName("expires_at").IsRequired();
        builder.Property(t => t.ConsumedAt).HasColumnName("consumed_at");
        builder.Property(t => t.SupersededAt).HasColumnName("superseded_at");

        builder.HasOne<AppUser>()
            .WithMany()
            .HasForeignKey(t => t.UserId)
            .HasConstraintName("fk_password_token_user")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(t => t.TokenHash).IsUnique().HasDatabaseName("ux_password_token_hash");
        builder.HasIndex(t => t.UserId).HasDatabaseName("ix_password_token_user_id");
    }
}
