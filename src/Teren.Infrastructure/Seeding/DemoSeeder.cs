using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;

namespace Teren.Infrastructure.Seeding;

/// <summary>
/// Seeds the demo company, project and entries the distributor demos from his phone.
/// This is a sales asset, not test data: everything must look like a real Serbian
/// plumbing/heating site. Idempotent — rows are keyed by fixed ids and never touched
/// once they exist (reported entries are immutable anyway).
/// </summary>
public static class DemoSeeder
{
    // Fixed ids so re-running the seed can recognise its own rows.
    public static readonly Guid CompanyId = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000001");
    public static readonly Guid ProjectId = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000002");
    public static readonly Guid Entry1Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000011");
    public static readonly Guid Entry2Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000012");
    public static readonly Guid Entry3Id = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000013");
    public static readonly Guid DemoDeviceId = Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-0000000000dd");

    public static async Task<int> SeedAsync(DbContext db, CancellationToken ct = default)
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
        if (!await projects.IgnoreQueryFilters().AnyAsync(p => p.Id == ProjectId, ct))
        {
            projects.Add(new Project
            {
                Id = ProjectId,
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
                CreatedAt = now,
            });
            inserted++;
        }

        var entries = db.Set<Entry>();

        // Day 1 — reported: pipe runs on the 2nd floor, hidden work photographed before closing.
        if (!await entries.IgnoreQueryFilters().AnyAsync(e => e.Id == Entry1Id, ct))
        {
            var captured = day1.ToDateTime(new TimeOnly(14, 40), DateTimeKind.Utc);
            entries.Add(new Entry
            {
                Id = Entry1Id,
                CompanyId = CompanyId,
                ProjectId = ProjectId,
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
                ProjectId = ProjectId,
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
                ProjectId = ProjectId,
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
        return inserted;
    }
}
