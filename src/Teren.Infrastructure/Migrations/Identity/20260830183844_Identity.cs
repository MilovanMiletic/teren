using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Teren.Infrastructure.Migrations.Identity
{
    /// <inheritdoc />
    public partial class Identity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "app_user",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    company_id = table.Column<Guid>(type: "uuid", nullable: true),
                    role = table.Column<string>(type: "text", nullable: false),
                    username = table.Column<string>(type: "text", nullable: true),
                    display_name = table.Column<string>(type: "text", nullable: false),
                    email = table.Column<string>(type: "text", nullable: true),
                    password_hash = table.Column<string>(type: "text", nullable: true),
                    language = table.Column<string>(type: "text", nullable: false, defaultValue: "sr"),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    last_login_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    disabled_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_app_user", x => x.id);
                    table.CheckConstraint("ck_app_user_admin_has_email", "role = 'worker' OR email IS NOT NULL");
                    table.CheckConstraint("ck_app_user_company_scope", "(role = 'super_admin') = (company_id IS NULL)");
                    table.CheckConstraint("ck_app_user_email_normalised", "email IS NULL OR email = lower(btrim(email))");
                    table.CheckConstraint("ck_app_user_role", "role IN ('super_admin','company_admin','worker')");
                    table.CheckConstraint("ck_app_user_username_normalised", "username IS NULL OR username = lower(btrim(username))");
                    table.CheckConstraint("ck_app_user_worker_has_no_password", "role <> 'worker' OR password_hash IS NULL");
                    table.CheckConstraint("ck_app_user_worker_has_username", "role <> 'worker' OR username IS NOT NULL");
                    table.ForeignKey(
                        name: "fk_app_user_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "admin_audit",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    actor_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    action = table.Column<string>(type: "text", nullable: false),
                    subject_type = table.Column<string>(type: "text", nullable: false),
                    subject_id = table.Column<Guid>(type: "uuid", nullable: true),
                    company_id = table.Column<Guid>(type: "uuid", nullable: true),
                    detail = table.Column<string>(type: "jsonb", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_admin_audit", x => x.id);
                    table.ForeignKey(
                        name: "fk_admin_audit_actor_user",
                        column: x => x.actor_user_id,
                        principalTable: "app_user",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_admin_audit_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "admin_session",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_hash = table.Column<string>(type: "char(64)", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_admin_session", x => x.id);
                    table.ForeignKey(
                        name: "fk_admin_session_user",
                        column: x => x.user_id,
                        principalTable: "app_user",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "device",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    company_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    token_hash = table.Column<string>(type: "char(64)", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    revoked_by_user_id = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_device", x => x.id);
                    table.ForeignKey(
                        name: "fk_device_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_device_revoked_by_user",
                        column: x => x.revoked_by_user_id,
                        principalTable: "app_user",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_device_user",
                        column: x => x.user_id,
                        principalTable: "app_user",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "password_token",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    purpose = table.Column<string>(type: "text", nullable: false),
                    token_hash = table.Column<string>(type: "char(64)", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    consumed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    superseded_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_password_token", x => x.id);
                    table.CheckConstraint("ck_password_token_purpose", "purpose IN ('invite','reset')");
                    table.ForeignKey(
                        name: "fk_password_token_user",
                        column: x => x.user_id,
                        principalTable: "app_user",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "activation_code",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    company_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_by_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    code_hash = table.Column<string>(type: "char(64)", nullable: false),
                    code_display = table.Column<string>(type: "text", nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    consumed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    consumed_device_id = table.Column<Guid>(type: "uuid", nullable: true),
                    superseded_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_activation_code", x => x.id);
                    table.CheckConstraint("ck_activation_code_display_cleared", "(consumed_at IS NULL AND superseded_at IS NULL) OR code_display IS NULL");
                    table.ForeignKey(
                        name: "fk_activation_code_company",
                        column: x => x.company_id,
                        principalTable: "company",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_activation_code_consumed_device",
                        column: x => x.consumed_device_id,
                        principalTable: "device",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_activation_code_created_by_user",
                        column: x => x.created_by_user_id,
                        principalTable: "app_user",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_activation_code_user",
                        column: x => x.user_id,
                        principalTable: "app_user",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_activation_code_company_id",
                table: "activation_code",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ix_activation_code_consumed_device_id",
                table: "activation_code",
                column: "consumed_device_id");

            migrationBuilder.CreateIndex(
                name: "ix_activation_code_created_by_user_id",
                table: "activation_code",
                column: "created_by_user_id");

            migrationBuilder.CreateIndex(
                name: "ux_activation_code_live",
                table: "activation_code",
                column: "user_id",
                unique: true,
                filter: "consumed_at IS NULL AND superseded_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "ix_admin_audit_actor_user_id",
                table: "admin_audit",
                column: "actor_user_id");

            migrationBuilder.CreateIndex(
                name: "ix_admin_audit_company_id",
                table: "admin_audit",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ix_admin_audit_created_at",
                table: "admin_audit",
                column: "created_at",
                descending: new bool[0]);

            migrationBuilder.CreateIndex(
                name: "ix_admin_session_user_id",
                table: "admin_session",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ux_admin_session_token_hash",
                table: "admin_session",
                column: "token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_app_user_company_id",
                table: "app_user",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ux_app_user_email",
                table: "app_user",
                column: "email",
                unique: true,
                filter: "email IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ux_app_user_username",
                table: "app_user",
                column: "username",
                unique: true,
                filter: "username IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "ix_device_company_id",
                table: "device",
                column: "company_id");

            migrationBuilder.CreateIndex(
                name: "ix_device_revoked_by_user_id",
                table: "device",
                column: "revoked_by_user_id");

            migrationBuilder.CreateIndex(
                name: "ix_device_user_id",
                table: "device",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ux_device_token_hash",
                table: "device",
                column: "token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_password_token_user_id",
                table: "password_token",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ux_password_token_hash",
                table: "password_token",
                column: "token_hash",
                unique: true);

            // ---------------------------------------------------------------- cross-tenant guard
            //
            // device.company_id and device.user_id are two independent foreign keys, so nothing so
            // far stops a device in company A being bound to a worker in company B. That row is
            // not a curiosity: the authenticator stamps entries from device.company_id, so it
            // would attribute one company's evidence to another company's NAMED MAN — and
            // attribution is the property this whole model exists to establish.
            //
            // A composite foreign key makes it unrepresentable. It is written here in raw SQL
            // rather than in the EF model because HasAlternateKey would force app_user.company_id
            // non-nullable, and NULL is exactly how a super_admin is spelled
            // (ck_app_user_company_scope). Postgres will happily back a foreign key with a unique
            // index over a nullable column; EF's model will not.
            //
            // Unreachable today — only the seeder and the test fixture insert devices — but D3's
            // activation endpoint makes it writable, and adding this while the schema is being
            // created is far cheaper than a migration over live rows later.
            migrationBuilder.Sql(
                """
                CREATE UNIQUE INDEX ux_app_user_company_id_id ON app_user (company_id, id);

                ALTER TABLE device
                    ADD CONSTRAINT fk_device_company_user
                    FOREIGN KEY (company_id, user_id)
                    REFERENCES app_user (company_id, id) ON DELETE RESTRICT;

                ALTER TABLE activation_code
                    ADD CONSTRAINT fk_activation_code_company_user
                    FOREIGN KEY (company_id, user_id)
                    REFERENCES app_user (company_id, id) ON DELETE RESTRICT;
                """);

            // Deliberately NOT given the same treatment: activation_code.created_by_user_id and
            // device.revoked_by_user_id. Decision 10 lets a super admin manage users across every
            // company, and a super admin has no company_id — so a composite key on either column
            // would make platform staff unable to issue a code or revoke a phone. Those two stay
            // plain foreign keys, and who may act is a role gate (D2), not a schema constraint.
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                ALTER TABLE activation_code DROP CONSTRAINT fk_activation_code_company_user;
                ALTER TABLE device DROP CONSTRAINT fk_device_company_user;
                DROP INDEX ux_app_user_company_id_id;
                """);

            migrationBuilder.DropTable(
                name: "activation_code");

            migrationBuilder.DropTable(
                name: "admin_audit");

            migrationBuilder.DropTable(
                name: "admin_session");

            migrationBuilder.DropTable(
                name: "password_token");

            migrationBuilder.DropTable(
                name: "device");

            migrationBuilder.DropTable(
                name: "app_user");
        }
    }
}
