using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ReportDelivery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "attempt_started_at",
                table: "report",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "attempts",
                table: "report",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "delivery_detail",
                table: "report",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "entry_id",
                table: "report",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "failure_reason",
                table: "report",
                type: "text",
                nullable: true);

            // The scaffolded default was the empty string, which ck_report_status below forbids —
            // a column whose default can never be stored. Every existing database has an empty
            // `report` table (nothing before B6 ever wrote one), so the backfill value is
            // academic; what matters is that the column carries no default afterwards, so an
            // INSERT that forgets the status fails loudly instead of writing a row the check
            // then rejects for a reason nobody can read.
            migrationBuilder.AddColumn<string>(
                name: "status",
                table: "report",
                type: "text",
                nullable: false,
                defaultValue: "sending");

            migrationBuilder.Sql("ALTER TABLE report ALTER COLUMN status DROP DEFAULT;");

            migrationBuilder.CreateIndex(
                name: "ux_report_entry_id",
                table: "report",
                column: "entry_id",
                unique: true,
                filter: "entry_id IS NOT NULL");

            migrationBuilder.AddCheckConstraint(
                name: "ck_report_sent_at",
                table: "report",
                sql: "(status = 'sent') = (sent_at IS NOT NULL)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_report_status",
                table: "report",
                sql: "status IN ('sending','sent','failed')");

            migrationBuilder.AddForeignKey(
                name: "fk_report_entry",
                table: "report",
                column: "entry_id",
                principalTable: "entry",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_report_entry",
                table: "report");

            migrationBuilder.DropIndex(
                name: "ux_report_entry_id",
                table: "report");

            migrationBuilder.DropCheckConstraint(
                name: "ck_report_sent_at",
                table: "report");

            migrationBuilder.DropCheckConstraint(
                name: "ck_report_status",
                table: "report");

            migrationBuilder.DropColumn(
                name: "attempt_started_at",
                table: "report");

            migrationBuilder.DropColumn(
                name: "attempts",
                table: "report");

            migrationBuilder.DropColumn(
                name: "delivery_detail",
                table: "report");

            migrationBuilder.DropColumn(
                name: "entry_id",
                table: "report");

            migrationBuilder.DropColumn(
                name: "failure_reason",
                table: "report");

            migrationBuilder.DropColumn(
                name: "status",
                table: "report");
        }
    }
}
