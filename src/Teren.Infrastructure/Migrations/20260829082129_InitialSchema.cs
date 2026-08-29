using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class InitialSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "company",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_company", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "project",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    company_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    address = table.Column<string>(type: "text", nullable: true),
                    latitude = table.Column<double>(type: "double precision", nullable: true),
                    longitude = table.Column<double>(type: "double precision", nullable: true),
                    recipients = table.Column<string>(type: "jsonb", nullable: true),
                    vocabulary = table.Column<string>(type: "jsonb", nullable: true),
                    report_language = table.Column<string>(type: "text", nullable: false, defaultValue: "sr"),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_project", x => x.id);
                    table.ForeignKey(
                        name: "fk_project_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "entry",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    company_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    entry_date = table.Column<DateOnly>(type: "date", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    raw_transcript = table.Column<string>(type: "text", nullable: true),
                    structure = table.Column<string>(type: "jsonb", nullable: true),
                    corrected = table.Column<string>(type: "jsonb", nullable: true),
                    weather = table.Column<string>(type: "jsonb", nullable: true),
                    latitude = table.Column<double>(type: "double precision", nullable: true),
                    longitude = table.Column<double>(type: "double precision", nullable: true),
                    gps_accuracy_m = table.Column<double>(type: "double precision", nullable: true),
                    supersedes_entry_id = table.Column<Guid>(type: "uuid", nullable: true),
                    device_id = table.Column<Guid>(type: "uuid", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    received_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    confirmed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    reported_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    failure_reason = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_entry", x => x.id);
                    table.CheckConstraint("ck_entry_corrected_schema_version", "corrected IS NULL OR jsonb_exists(corrected, 'schema_version')");
                    table.CheckConstraint("ck_entry_status", "status IN ('received','processing','awaiting_confirmation','needs_review','confirmed','reported')");
                    table.CheckConstraint("ck_entry_structure_schema_version", "structure IS NULL OR jsonb_exists(structure, 'schema_version')");
                    table.ForeignKey(
                        name: "fk_entry_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_entry_project",
                        column: x => x.project_id,
                        principalTable: "project",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_entry_supersedes_entry",
                        column: x => x.supersedes_entry_id,
                        principalTable: "entry",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "report",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    company_id = table.Column<Guid>(type: "uuid", nullable: false),
                    project_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    period_start = table.Column<DateOnly>(type: "date", nullable: false),
                    period_end = table.Column<DateOnly>(type: "date", nullable: false),
                    pdf_object_key = table.Column<string>(type: "text", nullable: true),
                    recipients = table.Column<string>(type: "jsonb", nullable: true),
                    sent_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_report", x => x.id);
                    table.CheckConstraint("ck_report_kind", "kind IN ('daily','weekly')");
                    table.ForeignKey(
                        name: "fk_report_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_report_project",
                        column: x => x.project_id,
                        principalTable: "project",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "media",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    company_id = table.Column<Guid>(type: "uuid", nullable: false),
                    entry_id = table.Column<Guid>(type: "uuid", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    object_key = table.Column<string>(type: "text", nullable: false),
                    content_type = table.Column<string>(type: "text", nullable: false),
                    byte_size = table.Column<long>(type: "bigint", nullable: false),
                    sha256 = table.Column<string>(type: "char(64)", nullable: false),
                    captured_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    upload_status = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_media", x => x.id);
                    table.CheckConstraint("ck_media_kind", "kind IN ('audio','photo')");
                    table.CheckConstraint("ck_media_upload_status", "upload_status IN ('pending','uploaded','verified','failed')");
                    table.ForeignKey(
                        name: "fk_media_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_media_entry",
                        column: x => x.entry_id,
                        principalTable: "entry",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_entry_company_id",
                table: "entry",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ix_entry_project_id_entry_date",
                table: "entry",
                columns: new[] { "project_id", "entry_date" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "ix_entry_status",
                table: "entry",
                column: "status");

            migrationBuilder.CreateIndex(
                name: "ix_entry_supersedes_entry_id",
                table: "entry",
                column: "supersedes_entry_id");

            migrationBuilder.CreateIndex(
                name: "ix_media_company_id",
                table: "media",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ix_media_entry_id",
                table: "media",
                column: "entry_id");

            migrationBuilder.CreateIndex(
                name: "ux_media_object_key",
                table: "media",
                column: "object_key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_project_company_id",
                table: "project",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ix_report_company_id",
                table: "report",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ix_report_project_id_period_start",
                table: "report",
                columns: new[] { "project_id", "period_start" },
                descending: new[] { false, true });

            // Immutability, enforced mechanically (PROJECT.md principle 2): once an entry is
            // reported it never changes and never disappears; the raw transcript is write-once.
            // The application layer enforces the same rules, but a convention is not evidence —
            // this trigger is what makes the promise hold against any SQL, not just EF.
            migrationBuilder.Sql(
                """
                CREATE FUNCTION entry_guard_update() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    IF OLD.reported_at IS NOT NULL THEN
                        RAISE EXCEPTION 'entry % is immutable: it was reported at %. Create a correction entry via supersedes_entry_id instead.',
                            OLD.id, OLD.reported_at;
                    END IF;
                    IF OLD.raw_transcript IS NOT NULL
                       AND NEW.raw_transcript IS DISTINCT FROM OLD.raw_transcript THEN
                        RAISE EXCEPTION 'entry %: raw_transcript is evidence and write-once; it is never edited or overwritten.',
                            OLD.id;
                    END IF;
                    RETURN NEW;
                END;
                $$;

                CREATE FUNCTION entry_guard_delete() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    IF OLD.reported_at IS NOT NULL THEN
                        RAISE EXCEPTION 'entry % is immutable: it was reported at % and cannot be deleted.',
                            OLD.id, OLD.reported_at;
                    END IF;
                    RETURN OLD;
                END;
                $$;

                CREATE TRIGGER trg_entry_guard_update
                    BEFORE UPDATE ON entry
                    FOR EACH ROW EXECUTE FUNCTION entry_guard_update();

                CREATE TRIGGER trg_entry_guard_delete
                    BEFORE DELETE ON entry
                    FOR EACH ROW EXECUTE FUNCTION entry_guard_delete();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                DROP TRIGGER trg_entry_guard_delete ON entry;
                DROP TRIGGER trg_entry_guard_update ON entry;
                DROP FUNCTION entry_guard_delete();
                DROP FUNCTION entry_guard_update();
                """);

            migrationBuilder.DropTable(
                name: "media");

            migrationBuilder.DropTable(
                name: "report");

            migrationBuilder.DropTable(
                name: "entry");

            migrationBuilder.DropTable(
                name: "project");

            migrationBuilder.DropTable(
                name: "company");
        }
    }
}
