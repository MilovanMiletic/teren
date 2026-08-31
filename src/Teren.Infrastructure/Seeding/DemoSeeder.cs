using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Reporting;

namespace Teren.Infrastructure.Seeding;

/// <summary>
/// Seeds the demo company, its three sites and the entries the distributor demos from his
/// phone. This is a sales asset, not test data: everything must look like a real Serbian
/// plumbing/heating contractor's book of work.
///
/// Three sites, because the Home screen's project picker is a dead control with a single item
/// and the buyer runs 3–20 active sites (PROJECT.md §2). Only site 1 carries entries: an empty
/// site is realistic, and it keeps the demo narrative on one site while the picker still
/// behaves like the real thing.
///
/// Idempotent per row, not per run: every row is guarded by its own fixed id, so a database
/// seeded at an earlier state gains exactly the rows it is missing and nothing else. Existing
/// rows are never updated (reported entries are immutable anyway).
/// </summary>
public static class DemoSeeder
{
    // Fixed ids so re-running the seed can recognise its own rows.
    public static readonly Guid CompanyId = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000001");
    public static readonly Guid Project1Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000002");
    public static readonly Guid Project2Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000003");
    public static readonly Guid Project3Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000004");
    public static readonly Guid Entry1Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000011");
    public static readonly Guid Entry2Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000012");
    public static readonly Guid Entry3Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000013");
    public static readonly Guid DemoDeviceId = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-0000000000dd");

    /// <summary>The customer: the man who owns the company and receives the reports.</summary>
    public static readonly Guid CompanyAdminId = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-0000000000a1");

    /// <summary>The foreman the three seeded entries were recorded by.</summary>
    public static readonly Guid WorkerId = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-0000000000a2");

    /// <summary>His durable identity — globally unique, and what he types to re-activate a phone.</summary>
    public const string WorkerUsername = "zoran.jovanovic";

    public const string WorkerEmail = "zoran.jovanovic@vodoinstal-petrovic.example.com";
    public const string CompanyAdminEmail = "petar.petrovic@vodoinstal-petrovic.example.com";

    /// <summary>What the admin would recognise the demo phone by in a device list.</summary>
    public const string DemoDeviceName = "Zoranov telefon";

    /// <summary>
    /// The demo worker's activation code, in canonical (folded) form — the 8 characters that get
    /// hashed. <b>This value is a contract</b>, in the same class as the three demo project ids:
    /// it is written down in CLAUDE.md and in <c>docs/demo-script.md</c>, and the distributor
    /// types it once to join a fresh phone. Change it and the written-down code stops working
    /// with nothing anywhere saying why.
    /// <para>
    /// Valid Crockford base32 and obviously demo material. It is shown as <c>DEM0-TEST</c>; a man
    /// who reads that as <c>DEMO-TEST</c> and types the letter O is also let in, because
    /// <see cref="ActivationCodeFormat.Fold"/> maps <c>O</c> to <c>0</c> — the same decode-time
    /// folding every real code relies on.
    /// </para>
    /// </summary>
    public const string DemoActivationCode = "DEM0TEST";

    /// <summary>The form the demo script prints and the admin screen will show: <c>DEM0-TEST</c>.
    /// Derived, never a second literal, so the two halves cannot drift apart.</summary>
    public static readonly string DemoActivationCodeDisplay =
        ActivationCodeFormat.Format(DemoActivationCode);

    /// <summary>
    /// How long the demo code lives — deliberately not the 7 days a real code gets.
    /// <para>
    /// A real code is a credential emailed to one named man, and its short life is what limits
    /// the damage of a forwarded message. The demo code is neither: it is seeded data, published
    /// in the repository, for a company whose entire contents are sample rows. Expiry buys
    /// nothing here and costs the one thing the demo exists for — a code that quietly died a week
    /// after the last <c>seed</c> is discovered by the distributor mid-pitch, in front of a
    /// customer, with no admin screen yet built to issue another. Ten years is "not while anyone
    /// is watching"; <c>seed</c> re-mints it anyway whenever it has been spent.
    /// </para>
    /// </summary>
    private static readonly TimeSpan DemoActivationCodeLifetime = TimeSpan.FromDays(3650);

    public static async Task<int> SeedAsync(
        DbContext db, string? deviceToken = null, CancellationToken ct = default)
    {
        var inserted = 0;
        var now = DateTime.UtcNow;
        // Recent working days so the demo always looks fresh on first seed.
        var day1 = DateOnly.FromDateTime(now.AddDays(-3));
        var day2 = DateOnly.FromDateTime(now.AddDays(-2));
        var day3 = DateOnly.FromDateTime(now.AddDays(-1));

        // The seeder runs outside any tenant scope on purpose.
        var companies = db.Set<Company>();
        if (!await companies.IgnoreQueryFilters().AnyAsync(c => c.Id == CompanyId, ct))
        {
            companies.Add(new Company
            {
                Id = CompanyId,
                Name = "Vodoinstal Petrović d.o.o.",
                CreatedAt = now,
            });
            inserted++;
        }

        var projects = db.Set<Project>();

        // Each site is guarded by its own id, so an already-seeded database picks up only the
        // sites it lacks. Never an upsert: a site the founder has edited by hand stays edited.
        async Task AddProjectAsync(Project project)
        {
            if (await projects.IgnoreQueryFilters().AnyAsync(p => p.Id == project.Id, ct))
            {
                return;
            }

            projects.Add(project);
            inserted++;
        }

        // Site 1 — the demo's narrative: the residential block all three entries belong to.
        await AddProjectAsync(new Project
        {
            Id = Project1Id,
            CompanyId = CompanyId,
            Name = "Stambena zgrada Vojvode Stepe 212",
            Address = "Vojvode Stepe 212, Voždovac, Beograd",
            // Voždovac, Belgrade.
            Latitude = 44.7692,
            Longitude = 20.4787,
            Recipients =
                """
                [{"name": "Dragan Obradović", "email": "dragan.obradovic@example.com", "role": "investitor"}]
                """,
            Vocabulary =
                """
                {
                  "work_items": ["razvod tople i hladne vode", "montaža vodokotlića", "montaža kotla", "štemovanje", "tlačna proba", "izolacija cevi"],
                  "materials": ["PPR cev 25mm", "PPR cev 32mm", "PPR fiting", "ugradni vodokotlić Geberit Duofix", "kotao Bosch Condens 4300i", "kuglasti ventil 1\""],
                  "workers": ["Nenad", "Zoran", "Miloš", "Ivan"]
                }
                """,
            ReportLanguage = "sr",
            TimeZone = ReportTimeZone.Default,
            CreatedAt = now,
        });

        // Site 2 — a second active site with no entries yet, so the picker has somewhere to go.
        // Business premises: sanitary blocks, fan-coils, a hydrant line, and a nadzorni organ
        // on the distribution list next to the investor, the way commercial jobs actually run.
        await AddProjectAsync(new Project
        {
            Id = Project2Id,
            CompanyId = CompanyId,
            Name = "Poslovni prostor Bulevar oslobođenja 84",
            Address = "Bulevar oslobođenja 84, Novi Sad",
            // Bulevar oslobođenja, Novi Sad.
            Latitude = 45.2512,
            Longitude = 19.8399,
            Recipients =
                """
                [{"name": "Jelena Marković", "email": "jelena.markovic@example.com", "role": "investitor"},
                 {"name": "Aleksandar Stanković", "email": "aleksandar.stankovic@example.com", "role": "nadzorni organ"}]
                """,
            Vocabulary =
                """
                {
                  "work_items": ["razvod sanitarne vode", "kanalizacioni razvod", "montaža sanitarije", "montaža fan-coil jedinica", "hidrantska mreža", "probijanje prodora", "tlačna proba"],
                  "materials": ["PPR cev 40mm", "kanalizaciona cev PVC 110mm", "bakarna cev 18mm", "fan-coil jedinica Daikin FWM", "hidrantski ormarić sa crevom 15m", "izolacija Armaflex 13mm", "kuglasti ventil 3/4\""],
                  "workers": ["Nenad", "Ivan", "Saša"]
                }
                """,
            ReportLanguage = "sr",
            TimeZone = ReportTimeZone.Default,
            CreatedAt = now,
        });

        // Site 3 — a small private job, the other half of a real contractor's book: a family
        // house on underfloor heating and a heat pump, one owner on the distribution list.
        await AddProjectAsync(new Project
        {
            Id = Project3Id,
            CompanyId = CompanyId,
            Name = "Kuća Miloša Obrenovića 17",
            Address = "Miloša Obrenovića 17, Zemun, Beograd",
            // Zemun, Belgrade.
            Latitude = 44.8452,
            Longitude = 20.4131,
            Recipients =
                """
                [{"name": "Milica Jovanović", "email": "milica.jovanovic@example.com", "role": "vlasnik"}]
                """,
            Vocabulary =
                """
                {
                  "work_items": ["podno grejanje", "razvod vode u kupatilima", "montaža toplotne pumpe", "montaža sanitarije", "izolacija cevi", "tlačna proba"],
                  "materials": ["Pex-Al-Pex cev 16mm", "razdelnik podnog grejanja 6 krugova", "toplotna pumpa Vaillant aroTHERM plus", "PPR cev 20mm", "sifon za tuš kadu", "termostatska glava"],
                  "workers": ["Zoran", "Miloš"]
                }
                """,
            ReportLanguage = "sr",
            TimeZone = ReportTimeZone.Default,
            CreatedAt = now,
        });

        var entries = db.Set<Entry>();

        // Day 1 — reported: pipe runs on the 2nd floor, hidden work photographed before closing.
        if (!await entries.IgnoreQueryFilters().AnyAsync(e => e.Id == Entry1Id, ct))
        {
            var captured = day1.ToDateTime(new TimeOnly(14, 40), DateTimeKind.Utc);
            entries.Add(new Entry
            {
                Id = Entry1Id,
                CompanyId = CompanyId,
                ProjectId = Project1Id,
                EntryDate = day1,
                Status = EntryStatus.Reported,
                RawTranscript =
                    "Danas smo radili razvod tople i hladne vode na drugom spratu, zapadno " +
                    "krilo. Postavljeno je nekih četrdeset metara PPR cevi od dvadeset pet. " +
                    "Bila su tri vodoinstalatera, ja, Zoran i Miloš. Stigla je isporuka od " +
                    "Pestana, cevi i fitinzi, sve po specifikaciji. Slikao sam razvod u " +
                    "zidovima pre nego što su zatvorili, to mora da se vidi posle.",
                Structure =
                    """
                    {
                      "schema_version": 1,
                      "work_done": [
                        {"description": "Razvod tople i hladne vode", "location": "2. sprat, zapadno krilo", "quantity": {"value": 40, "unit": "m"}}
                      ],
                      "headcount": {"total": 3, "roles": [{"role": "vodoinstalater", "count": 3}]},
                      "materials": [
                        {"name": "PPR cev 25mm", "quantity": {"value": 40, "unit": "m"}, "delivered": true},
                        {"name": "PPR fiting", "quantity": null, "delivered": true}
                      ],
                      "blockers": [],
                      "hidden_work": [
                        {"description": "Razvod cevi u zidovima 2. sprata pre zatvaranja", "media_ids": []}
                      ],
                      "notes": null
                    }
                    """,
                Corrected =
                    """
                    {
                      "schema_version": 1,
                      "work_done": [
                        {"description": "Razvod tople i hladne vode", "location": "2. sprat, zapadno krilo", "quantity": {"value": 42, "unit": "m"}}
                      ],
                      "headcount": {"total": 3, "roles": [{"role": "vodoinstalater", "count": 3}]},
                      "materials": [
                        {"name": "PPR cev 25mm (Pestan)", "quantity": {"value": 42, "unit": "m"}, "delivered": true},
                        {"name": "PPR fiting (Pestan)", "quantity": null, "delivered": true}
                      ],
                      "blockers": [],
                      "hidden_work": [
                        {"description": "Razvod cevi u zidovima 2. sprata pre zatvaranja", "media_ids": []}
                      ],
                      "notes": "Izmereno na licu mesta: 42 m, ne 40 m."
                    }
                    """,
                Weather =
                    """
                    {"source": "open-meteo", "conditions": "sunčano", "temperature_min_c": 19.2, "temperature_max_c": 30.5, "precipitation_mm": 0.0}
                    """,
                Latitude = 44.76931,
                Longitude = 20.47858,
                GpsAccuracyM = 9.5,
                DeviceId = DemoDeviceId,
                CreatedAt = captured,
                ReceivedAt = captured.AddSeconds(95),
                ConfirmedAt = captured.AddMinutes(24),
                ReportedAt = captured.AddMinutes(26),
            });
            inserted++;
        }

        // Day 2 — confirmed: Geberit installs on the 3rd floor, blocked in the boiler room.
        if (!await entries.IgnoreQueryFilters().AnyAsync(e => e.Id == Entry2Id, ct))
        {
            var captured = day2.ToDateTime(new TimeOnly(15, 5), DateTimeKind.Utc);
            entries.Add(new Entry
            {
                Id = Entry2Id,
                CompanyId = CompanyId,
                ProjectId = Project1Id,
                EntryDate = day2,
                Status = EntryStatus.Confirmed,
                RawTranscript =
                    "Danas montaža u kupatilima na trećem spratu, ugradili smo šest ugradnih " +
                    "vodokotlića Geberit i povezali odvode. Bilo nas je četvorica, tri " +
                    "vodoinstalatera i jedan pomoćni radnik. Problem je kotlarnica, ne možemo " +
                    "da počnemo dok električari ne završe štemovanje za kablove, čekamo ih od " +
                    "jutros. Kotao je stigao juče i stoji u magacinu.",
                Structure =
                    """
                    {
                      "schema_version": 1,
                      "work_done": [
                        {"description": "Ugradnja ugradnih vodokotlića Geberit i povezivanje odvoda", "location": "3. sprat, kupatila", "quantity": {"value": 6, "unit": "kom"}}
                      ],
                      "headcount": {"total": 4, "roles": [{"role": "vodoinstalater", "count": 3}, {"role": "pomoćni radnik", "count": 1}]},
                      "materials": [
                        {"name": "ugradni vodokotlić Geberit Duofix", "quantity": {"value": 6, "unit": "kom"}, "delivered": true},
                        {"name": "kotao Bosch Condens 4300i", "quantity": {"value": 1, "unit": "kom"}, "delivered": true}
                      ],
                      "blockers": [
                        {"description": "Štemovanje za kablove u kotlarnici nije završeno", "waiting_on": "električari"}
                      ],
                      "hidden_work": [],
                      "notes": "Kotao uskladišten u magacinu do završetka kotlarnice."
                    }
                    """,
                Corrected =
                    """
                    {
                      "schema_version": 1,
                      "work_done": [
                        {"description": "Ugradnja ugradnih vodokotlića Geberit Duofix i povezivanje odvoda", "location": "3. sprat, kupatila", "quantity": {"value": 6, "unit": "kom"}}
                      ],
                      "headcount": {"total": 4, "roles": [{"role": "vodoinstalater", "count": 3}, {"role": "pomoćni radnik", "count": 1}]},
                      "materials": [
                        {"name": "ugradni vodokotlić Geberit Duofix", "quantity": {"value": 6, "unit": "kom"}, "delivered": true},
                        {"name": "kotao Bosch Condens 4300i", "quantity": {"value": 1, "unit": "kom"}, "delivered": true}
                      ],
                      "blockers": [
                        {"description": "Štemovanje za kablove u kotlarnici nije završeno", "waiting_on": "električari"}
                      ],
                      "hidden_work": [],
                      "notes": "Kotao uskladišten u magacinu do završetka kotlarnice."
                    }
                    """,
                Weather =
                    """
                    {"source": "open-meteo", "conditions": "delimično oblačno", "temperature_min_c": 20.1, "temperature_max_c": 28.9, "precipitation_mm": 0.0}
                    """,
                Latitude = 44.76925,
                Longitude = 20.47871,
                GpsAccuracyM = 12.0,
                DeviceId = DemoDeviceId,
                CreatedAt = captured,
                ReceivedAt = captured.AddSeconds(70),
                ConfirmedAt = captured.AddMinutes(31),
            });
            inserted++;
        }

        // Day 3 — awaiting confirmation: boiler mounted, pressure test announced.
        if (!await entries.IgnoreQueryFilters().AnyAsync(e => e.Id == Entry3Id, ct))
        {
            var captured = day3.ToDateTime(new TimeOnly(14, 55), DateTimeKind.Utc);
            entries.Add(new Entry
            {
                Id = Entry3Id,
                CompanyId = CompanyId,
                ProjectId = Project1Id,
                EntryDate = day3,
                Status = EntryStatus.AwaitingConfirmation,
                RawTranscript =
                    "Ušli smo u kotlarnicu, električari su sinoć završili štemovanje. Počela " +
                    "je montaža kotla, Bosch kondenzacioni, okačen na zid i povezan na razvod. " +
                    "Sutra radimo tlačnu probu celog sistema na šest bari. Radila su dvojica, " +
                    "ja i Ivan. Trebaće nam još dva kuglasta ventila od jedan cola, naručio " +
                    "sam kod dobavljača.",
                Structure =
                    """
                    {
                      "schema_version": 1,
                      "work_done": [
                        {"description": "Montaža kondenzacionog kotla Bosch i povezivanje na razvod", "location": "kotlarnica", "quantity": {"value": 1, "unit": "kom"}}
                      ],
                      "headcount": {"total": 2, "roles": [{"role": "vodoinstalater", "count": 2}]},
                      "materials": [
                        {"name": "kuglasti ventil 1\"", "quantity": {"value": 2, "unit": "kom"}, "delivered": false}
                      ],
                      "blockers": [],
                      "hidden_work": [],
                      "notes": "Sutra tlačna proba celog sistema na 6 bar. Ventili naručeni kod dobavljača."
                    }
                    """,
                Corrected = null,
                Weather =
                    """
                    {"source": "open-meteo", "conditions": "sunčano", "temperature_min_c": 18.7, "temperature_max_c": 29.8, "precipitation_mm": 0.0}
                    """,
                Latitude = 44.76918,
                Longitude = 20.47844,
                GpsAccuracyM = 8.0,
                DeviceId = DemoDeviceId,
                CreatedAt = captured,
                ReceivedAt = captured.AddSeconds(60),
            });
            inserted++;
        }

        await db.SaveChangesAsync(ct);

        // Identity rows go in last and go in by hand. Two reasons, both load-bearing:
        //
        //   * They belong to TerenIdentityDbContext, which is a different context on a different
        //     connection — and DemoReset re-seeds inside ONE transaction. Writing them through
        //     that context would put them outside it, so a failed re-seed would leave the demo
        //     company holding entries with no device: a permanently 401ing demo that reports
        //     success. Raw SQL on this connection is the idiom DemoReset already uses throughout.
        //   * app_user.company_id and device.company_id reference the company row above, which
        //     until the SaveChanges on the line before this one exists only in the change tracker.
        inserted += await SeedIdentityAsync(db, deviceToken, now, ct);

        return inserted;
    }

    /// <summary>
    /// The company's people and the demo phone.
    /// <para>
    /// <b>The device row is the compatibility hinge of the whole identity feature.</b> Its
    /// <c>token_hash</c> is <c>SHA-256</c> of <c>Auth:DeviceToken</c>, so the token already
    /// compiled into the PWA bundle authenticates <em>for real</em>, as a genuine device bound to
    /// a genuine worker. That is what made it possible to delete the static-token authenticator
    /// outright instead of carrying a dual-credential path: <c>Auth:DeviceToken</c> stopped being
    /// a special case in code and became "the demo device's token, provisioned at seed time".
    /// </para>
    /// <para>
    /// <b>The one thing this method updates on an existing row is a withdrawal stamp.</b> There
    /// are exactly three that can leave a seeded demo unable to authenticate —
    /// <c>device.revoked_at</c>, <c>app_user.disabled_at</c> and <c>company.suspended_at</c> — and
    /// all three are cleared here, because <c>seed</c> is the command whose job is to put the demo
    /// back into a state it can be given from. Without that, revoking the demo phone from psql
    /// (which is exactly the capability D1 shipped) would be a one-way door: <c>seed</c> would
    /// report "already present, nothing inserted" and the phone would 401 forever with nothing
    /// anywhere saying why. Demo <em>content</em> — names, emails, the site list — is still never
    /// overwritten; a row the founder edited by hand stays edited.
    /// </para>
    /// </summary>
    private static async Task<int> SeedIdentityAsync(
        DbContext db, string? deviceToken, DateTime now, CancellationToken ct)
    {
        var inserted = 0;

        // The third withdrawal stamp, and the last thing that can leave a seeded demo unable to
        // authenticate. Deliberately the only company column this ever writes: name and the rest
        // are demo content the founder may have edited, and stay untouched.
        inserted += await db.Database.ExecuteSqlRawAsync(
            """
            UPDATE company SET suspended_at = NULL
            WHERE id = {0} AND suspended_at IS NOT NULL
            """,
            [CompanyId],
            ct);

        // The owner. password_hash stays NULL — he is invited, not provisioned with a password,
        // and ck_app_user_worker_has_no_password only constrains workers.
        inserted += await db.Database.ExecuteSqlRawAsync(
            """
            INSERT INTO app_user
                (id, company_id, role, username, display_name, email, password_hash, language,
                 created_at)
            VALUES ({0}, {1}, {2}, NULL, {3}, {4}, NULL, 'sr', {5})
            ON CONFLICT (id) DO UPDATE SET disabled_at = NULL
            WHERE app_user.disabled_at IS NOT NULL
            """,
            [CompanyAdminId, CompanyId, AppUserRoleNames.CompanyAdmin,
             "Petar Petrović", CompanyAdminEmail, now],
            ct);

        // The foreman the seeded entries were recorded by. A worker's email is optional but is
        // the normal case (§2 decision 6), and having one here is what makes the self-service
        // "send me a new code" path demonstrable.
        inserted += await db.Database.ExecuteSqlRawAsync(
            """
            INSERT INTO app_user
                (id, company_id, role, username, display_name, email, password_hash, language,
                 created_at)
            VALUES ({0}, {1}, {2}, {3}, {4}, {5}, NULL, 'sr', {6})
            ON CONFLICT (id) DO UPDATE SET disabled_at = NULL
            WHERE app_user.disabled_at IS NOT NULL
            """,
            [WorkerId, CompanyId, AppUserRoleNames.Worker, WorkerUsername,
             "Zoran Jovanović", WorkerEmail, now],
            ct);

        // The demo cannot be given without this. F4's canMatch gate sends a browser with no
        // session to /welcome, and there is no admin screen to issue a code from until F6 — so a
        // seeded demo with no live code is a demo that stops at the welcome screen.
        inserted += await SeedDemoActivationCodeAsync(db, now, ct);

        if (string.IsNullOrWhiteSpace(deviceToken))
        {
            // A legitimate configuration, not a failure: it is the D7 end state, where the PWA
            // stops carrying a baked-in token and the demo device is retired. Program.cs says so
            // once at start-up; the seed simply provisions no phone.
            return inserted;
        }

        // The one deliberate exception to "existing rows are never updated". Everything else the
        // seeder writes is demo *content*, which the founder may have edited on purpose. This row
        // is a *credential derived from configuration*, and `seed` is the command that is supposed
        // to put the demo back into a state it can be given from.
        //
        // Three things can leave the demo phone unable to authenticate, and all three are restored
        // here, because in every one of them `seed` would otherwise report success while the phone
        // 401s forever with nothing anywhere saying why:
        //
        //   * a rotated Auth__DeviceToken, leaving a stale token_hash;
        //   * a revoked_at stamp — and "revocation from psql" is exactly the capability D1 shipped,
        //     so the way back from it has to be the command the founder already reaches for;
        //   * revoked_by_user_id left pointing at whoever did it.
        //
        // The WHERE fires only when something actually differs, so a no-change re-seed still
        // reports zero rows affected and idempotence is unaffected.
        inserted += await db.Database.ExecuteSqlRawAsync(
            """
            INSERT INTO device (id, company_id, user_id, name, token_hash, created_at)
            VALUES ({0}, {1}, {2}, {3}, {4}, {5})
            ON CONFLICT (id) DO UPDATE SET
                token_hash = excluded.token_hash,
                revoked_at = NULL,
                revoked_by_user_id = NULL
            WHERE device.token_hash IS DISTINCT FROM excluded.token_hash
               OR device.revoked_at IS NOT NULL
               OR device.revoked_by_user_id IS NOT NULL
            """,
            [DemoDeviceId, CompanyId, WorkerId, DemoDeviceName,
             CredentialTokens.Hash(deviceToken), now],
            ct);

        return inserted;
    }

    /// <summary>
    /// The demo worker's one live activation code, with the fixed <see cref="DemoActivationCode"/>
    /// value the demo script tells the distributor to type.
    /// <para>
    /// <b>Re-minted, in the same spirit as the three withdrawal stamps above.</b> A consumed,
    /// superseded or expired code leaves the demo unjoinable while <c>seed</c> reports success —
    /// the same silent one-way door that revoking the demo phone used to be. Consuming the code
    /// is not an accident either: it is what the demo script now asks the distributor to do once.
    /// </para>
    /// <para>
    /// <b>The discipline here is <c>ActivationCodes.IssueAsync</c>'s, deliberately duplicated
    /// rather than called.</b> That method lives in <c>Teren.Api</c>, which this assembly cannot
    /// reference, and the identity rows here are written as raw SQL on this connection on purpose
    /// (see <see cref="SeedIdentityAsync"/>). The two rules it enforces are enforced here too:
    /// <c>ux_activation_code_live</c> permits at most one live code per worker, so anything else
    /// live is superseded first — <em>including an unconsumed but expired row</em>, which that
    /// partial index still counts as live because its predicate cannot mention <c>now()</c>; and
    /// <c>ck_activation_code_display_cleared</c> refuses to let a dead code keep holding its
    /// plaintext, so the supersede nulls <c>code_display</c> in the same statement.
    /// </para>
    /// </summary>
    private static async Task<int> SeedDemoActivationCodeAsync(
        DbContext db, DateTime now, CancellationToken ct)
    {
        var hash = CredentialTokens.Hash(DemoActivationCode);

        // In the steady state — the demo code live and unexpired — this matches nothing, which is
        // what keeps a second `seed` a no-op.
        var superseded = await db.Database.ExecuteSqlRawAsync(
            """
            UPDATE activation_code
               SET superseded_at = {1}, code_display = NULL
             WHERE user_id = {0}
               AND consumed_at IS NULL
               AND superseded_at IS NULL
               AND NOT (code_hash = {2} AND expires_at > {1})
            """,
            [WorkerId, now, hash],
            ct);

        // The NOT EXISTS is what makes a re-seed idempotent; the ON CONFLICT is the database
        // having the last word, so two seeds racing produce one code rather than an unhandled
        // unique violation. Its predicate has to repeat ux_activation_code_live's, because
        // Postgres only infers a partial index from an inference clause that names it.
        var minted = await db.Database.ExecuteSqlRawAsync(
            """
            INSERT INTO activation_code
                (id, company_id, user_id, created_by_user_id, code_hash, code_display,
                 created_at, expires_at)
            SELECT {0}, {1}, {2}, {3}, {4}, {5}, {6}, {7}
             WHERE NOT EXISTS (
                   SELECT 1 FROM activation_code
                    WHERE user_id = {2}
                      AND consumed_at IS NULL
                      AND superseded_at IS NULL
                      AND expires_at > {6})
            ON CONFLICT (user_id) WHERE consumed_at IS NULL AND superseded_at IS NULL
            DO NOTHING
            """,
            [
                Guid.NewGuid(), CompanyId, WorkerId, CompanyAdminId, hash,
                DemoActivationCodeDisplay, now, now.Add(DemoActivationCodeLifetime),
            ],
            ct);

        return superseded + minted;
    }
}
