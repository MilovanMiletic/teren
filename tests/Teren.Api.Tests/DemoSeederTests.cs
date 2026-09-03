using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// Invariant 8: the demo seed is a sales asset that has to survive being run again. It is
/// idempotent per row, not per run — a database seeded at an earlier state gains exactly the
/// rows it lacks and nothing already there is rewritten.
/// <para>
/// Each test gets its own database cloned from the migrated template, because "a database at an
/// older seed state" only means something on a database nothing else has touched.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class DemoSeederTests(TerenTestApp app)
{
    // 1 company + 3 sites + 3 entries + 2 users + 1 device
    private const int FullSeedRowCount = 11;

    /// <summary>The demo device's token. The seeded device's token_hash is SHA-256 of this, which
    /// is the whole compatibility hinge: the token already in the PWA bundle authenticates for
    /// real, as a genuine device row.</summary>
    private const string DemoDeviceToken = TerenTestApp.DeviceToken;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_fresh_database_gains_the_whole_demo()
    {
        await using var db = await app.CreateScratchDatabaseAsync();

        var inserted = (await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct)).RowsWritten;

        inserted.ShouldBe(FullSeedRowCount);
        (await db.Set<Company>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(1);
        (await db.Set<Project>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(3);
        (await db.Set<Entry>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(3);
    }

    [Fact]
    public async Task Seeding_twice_inserts_nothing_the_second_time()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);

        var second = (await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct)).RowsWritten;

        second.ShouldBe(0);
        (await db.Set<Project>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(3);
        (await db.Set<Entry>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(3);
    }

    [Fact]
    public async Task Seeding_a_third_time_is_still_a_no_op()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct)).RowsWritten.ShouldBe(0);
    }

    [Fact]
    public async Task A_database_at_an_older_seed_state_gains_exactly_the_missing_rows()
    {
        // The upgrade path that matters in practice: the founder's laptop was seeded when there
        // was one site, and the seeder now knows about three.
        await using var db = await app.CreateScratchDatabaseAsync();

        db.Set<Company>().Add(new Company
        {
            Id = DemoSeeder.CompanyId,
            Name = "Vodoinstal Petrović d.o.o.",
            CreatedAt = DateTime.UtcNow,
        });
        db.Set<Project>().Add(new Project
        {
            Id = DemoSeeder.Project1Id,
            CompanyId = DemoSeeder.CompanyId,
            Name = "Ime koje je vlasnik ručno izmenio",
            ReportLanguage = "en",
            CreatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync(Ct);

        var inserted = (await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct)).RowsWritten;

        // Two sites, three entries, two users, the device and the demo activation code; the
        // company and site 1 were there.
        inserted.ShouldBe(9);
        (await db.Set<Company>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(1);
        (await db.Set<Project>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(3);
        (await db.Set<Entry>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(3);
    }

    [Fact]
    public async Task A_row_the_founder_edited_by_hand_is_never_overwritten()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);

        var edited = await db.Set<Project>().IgnoreQueryFilters()
            .FirstAsync(p => p.Id == DemoSeeder.Project1Id, Ct);
        edited.Name = "Ime koje je vlasnik ručno izmenio";
        edited.ReportLanguage = "en";
        await db.SaveChangesAsync(Ct);
        db.ChangeTracker.Clear();

        (await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct)).RowsWritten.ShouldBe(0);

        var after = await db.Set<Project>().IgnoreQueryFilters().AsNoTracking()
            .FirstAsync(p => p.Id == DemoSeeder.Project1Id, Ct);
        after.Name.ShouldBe("Ime koje je vlasnik ručno izmenio");
        after.ReportLanguage.ShouldBe("en");
    }

    [Fact]
    public async Task The_seeded_ids_are_the_contract_the_pwa_mirrors()
    {
        // web/teren-pwa/src/app/core/projects/project-source.ts carries these same ids as its
        // offline fallback list (ARCHITECTURE §6). If they drift, every POST /api/entries 404s
        // and locally captured entries become unsendable — so they are pinned here as literals,
        // not read back from the class under test.
        DemoSeeder.CompanyId.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000001"));
        DemoSeeder.Project1Id.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000002"));
        DemoSeeder.Project2Id.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000003"));
        DemoSeeder.Project3Id.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000004"));

        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);

        var ids = await db.Set<Project>().IgnoreQueryFilters()
            .Select(p => p.Id).ToListAsync(Ct);
        ids.ShouldBe(
            [DemoSeeder.Project1Id, DemoSeeder.Project2Id, DemoSeeder.Project3Id],
            ignoreOrder: true);
    }

    [Fact]
    public async Task The_demo_narrative_is_intact()
    {
        // What the distributor actually shows: three sites, all entries on site 1, one of each
        // status the confirmation flow can be demonstrated from, and a multi-recipient site so
        // B6 has a real case.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct);

        var entries = await db.Set<Entry>().IgnoreQueryFilters().ToListAsync(Ct);
        entries.ShouldAllBe(e => e.ProjectId == DemoSeeder.Project1Id);
        entries.Select(e => e.Status).ShouldBe(
            [EntryStatus.Reported, EntryStatus.Confirmed, EntryStatus.AwaitingConfirmation],
            ignoreOrder: true);

        var reported = entries.Single(e => e.Status == EntryStatus.Reported);
        reported.ReportedAt.ShouldNotBeNull();
        reported.RawTranscript.ShouldNotBeNullOrWhiteSpace();
        reported.Corrected.ShouldNotBeNullOrWhiteSpace();

        var site2 = await db.Set<Project>().IgnoreQueryFilters()
            .FirstAsync(p => p.Id == DemoSeeder.Project2Id, Ct);
        site2.Recipients.ShouldNotBeNull();
        site2.Recipients!.Split("\"email\"").Length.ShouldBe(3); // two recipients
    }

    [Fact]
    public async Task Seeded_entries_satisfy_the_schema_version_check_constraints()
    {
        // The seeder writes JSONB straight into columns Postgres CHECKs; a demo that cannot be
        // seeded is a demo that cannot be given.
        await using var db = await app.CreateScratchDatabaseAsync();

        await Should.NotThrowAsync(async () => await DemoSeeder.SeedAsync(db, DemoDeviceToken, useFixedDemoCode: true, Ct));

        var structures = await db.Set<Entry>().IgnoreQueryFilters()
            .Select(e => e.Structure).ToListAsync(Ct);
        structures.ShouldAllBe(s => s!.Contains("schema_version"));
    }
}
