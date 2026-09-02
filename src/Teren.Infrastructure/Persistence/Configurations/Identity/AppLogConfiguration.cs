using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// <c>app_log</c> — the super admin's log stream (plan §12).
///
/// <para>
/// <b><c>bigserial</c>, not a uuid, and it is the only one in the product.</b> Every other key here
/// is client-generated because it has to survive a phone being offline; a log row is written by
/// the server, in order, and a monotonically increasing key is what makes
/// <c>(at DESC, id DESC)</c> keyset paging over a firehose an index scan instead of a sort.
/// </para>
///
/// <para>
/// <b>No foreign keys on <c>company_id</c> or <c>entry_id</c>, deliberately.</b> They are there to
/// find rows by. A referential constraint would mean a log line about a company that is being
/// created — or about an entry the transaction rolled back — fails to insert, and the line lost
/// would be precisely the one explaining the failure. Same reasoning as <c>entry.device_id</c>
/// (ARCHITECTURE §12).
/// </para>
///
/// <para>
/// The three indexes are the three questions the viewer asks: "what just happened" (newest first),
/// "what is failing" (a level, newest first), and "what is failing for this customer".
/// </para>
/// </summary>
public sealed class AppLogConfiguration : IEntityTypeConfiguration<AppLog>
{
    public void Configure(EntityTypeBuilder<AppLog> builder)
    {
        builder.ToTable("app_log", table => table.HasCheckConstraint(
            "ck_app_log_level",
            $"level IN ({Sql.Quoted(AppLogLevels.All)})"));

        builder.HasKey(l => l.Id).HasName("pk_app_log");

        builder.Property(l => l.Id).HasColumnName("id").ValueGeneratedOnAdd();
        builder.Property(l => l.At).HasColumnName("at").IsRequired();
        builder.Property(l => l.Level).HasColumnName("level").IsRequired();
        builder.Property(l => l.Source).HasColumnName("source").IsRequired();
        builder.Property(l => l.Template).HasColumnName("template").IsRequired();
        builder.Property(l => l.Message).HasColumnName("message").IsRequired();
        builder.Property(l => l.Properties).HasColumnName("properties").HasColumnType("jsonb");
        builder.Property(l => l.Exception).HasColumnName("exception");
        builder.Property(l => l.CompanyId).HasColumnName("company_id");
        builder.Property(l => l.EntryId).HasColumnName("entry_id");
        builder.Property(l => l.Correlation).HasColumnName("correlation");

        builder.HasIndex(l => l.At)
            .IsDescending()
            .HasDatabaseName("ix_app_log_at");

        builder.HasIndex(l => new { l.Level, l.At })
            .IsDescending(false, true)
            .HasDatabaseName("ix_app_log_level_at");

        builder.HasIndex(l => new { l.CompanyId, l.At })
            .IsDescending(false, true)
            .HasDatabaseName("ix_app_log_company_id_at");
    }
}
