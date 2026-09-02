using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ReportCorrectedChecksum : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // SHA-256 of the `entry.corrected` document this report's PDF was laid out from, so a
            // pass that finds a `sent` report whose entry was never sealed can ask whether the
            // entry still holds what went out. Nullable, like pdf_sha256 and for the same reason:
            // rows written before the column existed carry no answer and are not refused one.
            // See Teren.Core/Entities/Report.cs and EntryReporter.SealAsync.
            migrationBuilder.AddColumn<string>(
                name: "corrected_sha256",
                table: "report",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "corrected_sha256",
                table: "report");
        }
    }
}
