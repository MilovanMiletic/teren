using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ReportSendingIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // PipelineSweeper.FailAbandonedReportsAsync runs
            //   WHERE status = 'sending' AND attempt_started_at < @cutoff
            // every minute, and `report` had no index on either column. Partial on purpose: after
            // the first week almost every row is `sent`, so an index on `status` is one Postgres
            // would decline to use — a write cost with no read benefit. See ReportConfiguration.
            migrationBuilder.CreateIndex(
                name: "ix_report_sending_attempt",
                table: "report",
                column: "attempt_started_at",
                filter: "status = 'sending'");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_report_sending_attempt",
                table: "report");
        }
    }
}
