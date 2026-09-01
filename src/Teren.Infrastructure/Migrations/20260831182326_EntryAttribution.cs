using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations
{
    /// <summary>
    /// D8 — who recorded a day, and who approved what its report would say.
    ///
    /// <para>
    /// <b>Safe on a database full of reported entries, and the reason is worth stating because it
    /// will look wrong to someone.</b> <c>trg_entry_guard_update</c> raises on any UPDATE of a row
    /// whose <c>reported_at</c> is set. <c>ALTER TABLE … ADD COLUMN</c> with no default is
    /// <b>DDL, not an UPDATE</b>: Postgres does not rewrite the rows and no row trigger fires. The
    /// thing that is genuinely impossible is <em>backfilling values</em>, and this migration does
    /// not attempt it. A null means "recorded before Teren tracked people" — inventing a plausible
    /// author for sealed evidence is precisely what these columns exist to prevent.
    /// </para>
    /// <para>
    /// <b>No foreign key to <c>app_user</c>, and that is a deviation from plan §4 taken on
    /// purpose.</b> <c>TerenDbContext</c> migrates before <c>TerenIdentityDbContext</c> everywhere
    /// the product migrates (<c>Program.cs</c>, <c>DemoResetCommand</c>), so on a fresh database
    /// <c>app_user</c> does not exist at the moment this runs and the constraint could not be
    /// created. The guarantee the FK was there to give — a user who has authored an entry can
    /// never be hard-deleted — currently has nothing to restrain: no path in <c>src/</c> deletes an
    /// <c>app_user</c>, because "remove a worker" is <c>disabled_at</c>. **When D4 makes user
    /// deletion reachable, the constraint has to arrive with it**, and it belongs in the identity
    /// history, which runs second and can see both tables.
    /// </para>
    /// </summary>
    public partial class EntryAttribution : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "confirmed_by_user_id",
                table: "entry",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "created_by_user_id",
                table: "entry",
                type: "uuid",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "confirmed_by_user_id",
                table: "entry");

            migrationBuilder.DropColumn(
                name: "created_by_user_id",
                table: "entry");
        }
    }
}
