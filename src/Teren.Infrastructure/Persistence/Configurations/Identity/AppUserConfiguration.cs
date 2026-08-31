using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <c>app_user</c>. The role rules are enforced by CHECK constraints rather than by convention,
/// the same taste <c>ck_entry_status</c> already sets: a constraint makes a state unreachable,
/// a code review makes it unlikely.
/// </summary>
public sealed class AppUserConfiguration : IEntityTypeConfiguration<AppUser>
{
    public void Configure(EntityTypeBuilder<AppUser> builder)
    {
        builder.ToTable("app_user", table =>
        {
            table.HasCheckConstraint(
                "ck_app_user_role",
                $"role IN ({Sql.Quoted(AppUserRoleNames.All)})");

            // Reads twice, and is worth it: with this in place no INSERT, no UPDATE and no
            // migration can produce a super_admin row that a tenant query filter would ever match.
            table.HasCheckConstraint(
                "ck_app_user_company_scope",
                $"(role = '{AppUserRoleNames.SuperAdmin}') = (company_id IS NULL)");

            // An admin who can never be reset is a support call nobody can answer.
            table.HasCheckConstraint(
                "ck_app_user_admin_has_email",
                $"role = '{AppUserRoleNames.Worker}' OR email IS NOT NULL");

            // A second door into the diary. There is exactly one door, and it is the device.
            table.HasCheckConstraint(
                "ck_app_user_worker_has_no_password",
                $"role <> '{AppUserRoleNames.Worker}' OR password_hash IS NULL");

            // The worker's identity outlives his phone, so he must have one.
            table.HasCheckConstraint(
                "ck_app_user_worker_has_username",
                $"role <> '{AppUserRoleNames.Worker}' OR username IS NOT NULL");

            // Case-insensitivity by normalising on write rather than by citext — no
            // CREATE EXTENSION, following the "No PostGIS" precedent. The CHECK is what stops
            // two rows differing only in case, which a partial unique index alone would allow.
            table.HasCheckConstraint(
                "ck_app_user_email_normalised",
                "email IS NULL OR email = lower(btrim(email))");

            table.HasCheckConstraint(
                "ck_app_user_username_normalised",
                "username IS NULL OR username = lower(btrim(username))");
        });

        builder.HasKey(u => u.Id).HasName("pk_app_user");

        builder.Property(u => u.Id).HasColumnName("id").ValueGeneratedNever();
        builder.Property(u => u.CompanyId).HasColumnName("company_id");
        builder.Property(u => u.Role)
            .HasColumnName("role")
            .HasConversion(StatusConverters.AppUserRole)
            .IsRequired();
        builder.Property(u => u.Username).HasColumnName("username");
        builder.Property(u => u.DisplayName).HasColumnName("display_name").IsRequired();
        builder.Property(u => u.Email).HasColumnName("email");
        builder.Property(u => u.PasswordHash).HasColumnName("password_hash");
        builder.Property(u => u.Language)
            .HasColumnName("language")
            .IsRequired()
            .HasDefaultValue("sr");
        builder.Property(u => u.CreatedAt).HasColumnName("created_at").IsRequired();
        builder.Property(u => u.LastLoginAt).HasColumnName("last_login_at");
        builder.Property(u => u.DisabledAt).HasColumnName("disabled_at");

        builder.HasOne<Company>()
            .WithMany()
            .HasForeignKey(u => u.CompanyId)
            .HasConstraintName("fk_app_user_company")
            .OnDelete(DeleteBehavior.Restrict);

        // Partial, not plain: decision 6 makes a worker's email optional, so NULLs must not
        // collide. Precedent is ux_report_entry_id. Uniqueness is global rather than per-company
        // because email is the login key and a login form has no company field.
        builder.HasIndex(u => u.Email)
            .IsUnique()
            .HasFilter("email IS NOT NULL")
            .HasDatabaseName("ux_app_user_email");

        builder.HasIndex(u => u.Username)
            .IsUnique()
            .HasFilter("username IS NOT NULL")
            .HasDatabaseName("ux_app_user_username");

        builder.HasIndex(u => u.CompanyId).HasDatabaseName("ix_app_user_company_id");

        // NOTE: the cross-tenant guard that hangs off this table — a COMPOSITE foreign key
        // (company_id, user_id) from device and activation_code — is created in raw SQL by the
        // Identity migration, not here. It cannot be an EF alternate key: HasAlternateKey forces
        // its properties non-nullable, and company_id is nullable by design, because NULL is
        // exactly how a super_admin is spelled (ck_app_user_company_scope). Postgres is happy to
        // back a foreign key with a unique index over a nullable column; EF's model is not.
    }
}
