using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ProjectTimeZoneAndReportChecksum : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Nullable, and it stays nullable: rows written before this column existed recorded
            // no checksum, and a report that was genuinely sent must stay downloadable. The read
            // path serves those unverified and says so in the log rather than refusing them.
            migrationBuilder.AddColumn<string>(
                name: "pdf_sha256",
                table: "report",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            // The database default is kept — unlike report.status in the previous migration,
            // where the scaffolded default was dropped because it named a value the CHECK
            // constraint forbids. Here the default is the intended one and the same shape
            // report_language already has: every existing project is backfilled to the market's
            // zone, and a future INSERT that omits it gets a correct value rather than a row that
            // cannot render a timestamp.
            migrationBuilder.AddColumn<string>(
                name: "time_zone",
                table: "project",
                type: "text",
                nullable: false,
                defaultValue: "Europe/Belgrade");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "pdf_sha256",
                table: "report");

            migrationBuilder.DropColumn(
                name: "time_zone",
                table: "project");
        }
    }
}
