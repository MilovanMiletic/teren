using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class CompanySuspension : Migration
    {
        /// <inheritdoc />
        // Nullable with no default, so this is ADD COLUMN as pure catalogue DDL: Postgres does
        // not rewrite a single row and no row trigger fires. Nothing is backfilled — an
        // unsuspended company is the absence of a stamp, not a flag set to false.
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "suspended_at",
                table: "company",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "suspended_at",
                table: "company");
        }
    }
}
