using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <c>activation_code</c>. Two guards here are the whole design, expressed in the schema.
/// </summary>
public sealed class ActivationCodeConfiguration : IEntityTypeConfiguration<ActivationCode>
{
    public void Configure(EntityTypeBuilder<ActivationCode> builder)
    {
        builder.ToTable("activation_code", table =>
            // A dead code cannot still be holding plaintext. Expiry is deliberately absent from
            // this predicate for the same reason it is absent from ux_activation_code_live: it
            // cannot be expressed without now(), and a CHECK must be immutable. An expired code's
            // display value is cleared by the code that reads it (D3).
            table.HasCheckConstraint(
                "ck_activation_code_display_cleared",
                "(consumed_at IS NULL AND superseded_at IS NULL) OR code_display IS NULL"));

        builder.HasKey(c => c.Id).HasName("pk_activation_code");

        builder.Property(c => c.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(c => c.CompanyId).HasColumnName("company_id").IsRequired();
        builder.Property(c => c.UserId).HasColumnName("user_id").IsRequired();
        builder.Property(c => c.CreatedByUserId).HasColumnName("created_by_user_id").IsRequired();
        builder.Property(c => c.CodeHash)
            .HasColumnName("code_hash")
            .HasColumnType($"char({CredentialTokens.HashLength})")
            .IsRequired();
        builder.Property(c => c.CodeDisplay).HasColumnName("code_display");
        builder.Property(c => c.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(c => c.ExpiresAt).HasColumnName("expires_at").IsRequired();
        builder.Property(c => c.ConsumedAt).HasColumnName("consumed_at");
        builder.Property(c => c.ConsumedDeviceId).HasColumnName("consumed_device_id");
        builder.Property(c => c.SupersededAt).HasColumnName("superseded_at");

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(c => c.CompanyId)
            .HasConstraintName("fk_activation_code_company")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<AppUser>()
            .WithMany()
            .HasForeignKey(c => c.UserId)
            .HasConstraintName("fk_activation_code_user")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<AppUser>()
            .WithMany()
            .HasForeignKey(c => c.CreatedByUserId)
            .HasConstraintName("fk_activation_code_created_by_user")
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne<Device>()
            .WithMany()
            .HasForeignKey(c => c.ConsumedDeviceId)
            .HasConstraintName("fk_activation_code_consumed_device")
            .OnDelete(DeleteBehavior.Restrict);

        // At most one typeable code per worker, guaranteed by the database rather than by a
        // handler remembering to supersede the old one.
        //
        // EXPIRY IS DELIBERATELY NOT IN THIS PREDICATE, and it must never be added: a partial
        // index predicate has to be immutable and now() is not, so Postgres would refuse the
        // index outright. Expiry is checked at activation time. §4 spells this out at length —
        // this is the one line in the schema most likely to be "fixed" by someone who has not
        // read that paragraph, so a test asserts the predicate does not mention now().
        builder.HasIndex(c => c.UserId)
            .IsUnique()
            .HasFilter("consumed_at IS NULL AND superseded_at IS NULL")
            .HasDatabaseName("ux_activation_code_live");

        builder.HasIndex(c => c.CompanyId).HasDatabaseName("ix_activation_code_company_id");

        // Named explicitly rather than left to EF, which would call them IX_* against the house
        // ix_*/ux_* convention. These are schema: nobody renames an index later.
        builder.HasIndex(c => c.CreatedByUserId)
            .HasDatabaseName("ix_activation_code_created_by_user_id");
        builder.HasIndex(c => c.ConsumedDeviceId)
            .HasDatabaseName("ix_activation_code_consumed_device_id");
    }
}
