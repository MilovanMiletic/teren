using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Infrastructure.Persistence;
using Teren.Core.Storage;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// B7 demo integrity. <c>seed</c> can add what is missing but can never undo a demo: every demo
/// the distributor gives leaves a real "test test" entry behind, which is confirmed, reported and
/// then sealed permanently by <c>trg_entry_guard_delete</c>. <c>reset-demo</c> is the way back.
/// <para>
/// Every database test runs on its own database cloned from the migrated template, because the
/// triggers, the RESTRICT foreign keys and the CHECK constraints are the subject — not something
/// in the way of it.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class DemoResetTests(TerenTestApp app)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string DemoDeviceToken = TerenTestApp.DeviceToken;

    /// <summary>1 company + 3 sites + 3 entries + 2 users + 1 device + 1 activation code — the
    /// same number DemoSeederTests pins, because a reset that re-seeded a different shape than a
    /// seed would be a reset that quietly changed the demo.</summary>
    private const int FullSeedRowCount = 11;

    private static readonly Guid OtherCompanyId = Guid.Parse("11111111-2222-3333-4444-555555555555");
    private static readonly Guid OtherProjectId = Guid.Parse("11111111-2222-3333-4444-555555555556");
    private static readonly Guid OtherEntryId = Guid.Parse("11111111-2222-3333-4444-555555555557");

    // ---------------------------------------------------------------- the guard

    [Fact]
    public void A_production_host_is_refused_even_with_the_confirmation_flag()
    {
        // The case this whole type exists for: the founder, tired, over SSH, on the wrong box.
        var decision = DemoResetGuard.Evaluate(
            "Production",
            resetEnabled: false,
            [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag]);

        decision.Verdict.ShouldBe(DemoResetVerdict.Refused);
        decision.ExitCode.ShouldNotBe(0);
        decision.Message.ShouldContain("REFUSED");
        // It must say what would make it legal, or the founder will reach for something worse.
        decision.Message.ShouldContain("Demo__ResetEnabled");
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    [InlineData("production")]
    [InlineData("")]
    [InlineData(null)]
    public void Any_host_that_has_not_declared_itself_a_demo_host_is_refused(string? environment)
    {
        DemoResetGuard.Evaluate(
                environment,
                resetEnabled: false,
                [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag])
            .Verdict.ShouldBe(DemoResetVerdict.Refused);
    }

    [Fact]
    public void A_production_host_is_refused_before_it_is_even_inspected()
    {
        // Not a dry run, a refusal: on a host that has not declared itself a demo host this
        // command does not exist at all, so it does not read the database either.
        DemoResetGuard.Evaluate(
                "Production",
                resetEnabled: false,
                [DemoResetGuard.CommandName, DemoResetGuard.DryRunFlag])
            .Verdict.ShouldBe(DemoResetVerdict.Refused);
    }

    [Fact]
    public void The_staging_demo_box_may_reset_because_it_carries_the_flag()
    {
        // deploy/docker-compose.prod.yml runs staging with ASPNETCORE_ENVIRONMENT=Production, so
        // the environment name alone cannot tell the demo box from a real one.
        var decision = DemoResetGuard.Evaluate(
            "Production",
            resetEnabled: true,
            [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag]);

        decision.Verdict.ShouldBe(DemoResetVerdict.Proceed);
        decision.ExitCode.ShouldBe(0);
    }

    [Fact]
    public void Development_with_the_confirmation_flag_proceeds()
    {
        DemoResetGuard.Evaluate(
                "Development",
                resetEnabled: false,
                [DemoResetGuard.CommandName, DemoResetGuard.ConfirmFlag])
            .Verdict.ShouldBe(DemoResetVerdict.Proceed);
    }

    [Fact]
    public void Without_the_confirmation_flag_it_only_says_what_it_would_destroy()
    {
        var decision = DemoResetGuard.Evaluate(
            "Development", resetEnabled: false, [DemoResetGuard.CommandName]);

        decision.Verdict.ShouldBe(DemoResetVerdict.DryRun);
        // Asked for a reset and did not get one: a script must be able to tell.
        decision.ExitCode.ShouldNotBe(0);
        decision.Message.ShouldContain("PERMANENTLY DELETES");
        decision.Message.ShouldContain(DemoResetGuard.ConfirmFlag);
    }

    [Fact]
    public void An_explicit_dry_run_succeeds()
    {
        var decision = DemoResetGuard.Evaluate(
            "Development", resetEnabled: false,
            [DemoResetGuard.CommandName, DemoResetGuard.DryRunFlag]);

        decision.Verdict.ShouldBe(DemoResetVerdict.DryRun);
        decision.ExitCode.ShouldBe(0);
    }

    [Fact]
    public void The_command_word_has_to_be_typed_in_full()
    {
        // No ambient default, and no short alias that could be reached by accident.
        DemoResetGuard.Evaluate("Development", resetEnabled: true, ["seed", "--yes", "-f", "reset"])
            .Verdict.ShouldBe(DemoResetVerdict.Refused);
    }

    [Fact]
    public void The_confirmation_flag_names_what_it_destroys()
    {
        // Not -f and not -y: this flag cannot be muscle memory from another command.
        DemoResetGuard.ConfirmFlag.ShouldBe("--yes-delete-demo-data");
        DemoResetGuard.CommandName.ShouldBe("reset-demo");
    }

    [Fact]
    public void The_reset_is_scoped_to_the_seeded_demo_company_and_nothing_else()
    {
        DemoReset.CompanyId.ShouldBe(DemoSeeder.CompanyId);
        DemoReset.CompanyId.ShouldBe(Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000001"));
        DemoReset.ObjectPrefix.ShouldBe("company/d3a0c1f0-5b8e-4f1a-9c62-000000000001/");
    }

    // ---------------------------------------------------------------- the reset

    [Fact]
    public async Task Ten_demos_worth_of_junk_is_removed_and_the_seed_comes_back()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        await GivenJunkFromDemosAsync(db, count: 10);

        var result = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        result.Removed.Entries.ShouldBe(13); // 3 seeded + 10 demo leftovers
        result.Removed.Media.ShouldBe(10);
        result.Removed.Reports.ShouldBe(10);
        result.Removed.Projects.ShouldBe(3);
        result.Removed.Companies.ShouldBe(1);
        result.ReportedEntriesRemoved.ShouldBe(11); // 10 demo leftovers + seeded entry 1
        result.Reseeded.ShouldBe(FullSeedRowCount);

        result.FinalState.ShouldBe(new DemoRowCounts(
            Companies: 1, Projects: 3, Entries: 3, Media: 0, Reports: 0,
            AppUsers: 2, Devices: 1, ActivationCodes: 1, PasswordTokens: 0,
            AdminSessions: 0, AdminAudits: 0));

        var entries = await AllEntriesAsync(db);
        entries.Select(e => e.Id).ShouldBe(
            [DemoSeeder.Entry1Id, DemoSeeder.Entry2Id, DemoSeeder.Entry3Id], ignoreOrder: true);
        entries.Select(e => e.Status).ShouldBe(
            [EntryStatus.Reported, EntryStatus.Confirmed, EntryStatus.AwaitingConfirmation],
            ignoreOrder: true);
    }

    [Fact]
    public async Task The_immutability_guard_is_armed_again_after_a_reset()
    {
        // The property the whole design turns on. If the reset left trg_entry_guard_delete off,
        // every reported entry in the database — evidence somebody may rely on in a dispute —
        // would be silently deletable, and nothing else in the system would notice.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        await GivenJunkFromDemosAsync(db, count: 2);

        var result = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        result.GuardArmed.ShouldBeTrue();

        // Asked of Postgres, not of the result object: a reported entry must still refuse to die.
        var reported = (await AllEntriesAsync(db)).Single(e => e.ReportedAt is not null);

        var refusal = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlRawAsync(
                "DELETE FROM entry WHERE id = {0}", [reported.Id], Ct));

        refusal.MessageText.ShouldContain("immutable");
        (await AllEntriesAsync(db)).Count.ShouldBe(3);
    }

    [Fact]
    public async Task The_update_guard_is_never_stood_down_at_all()
    {
        // Only the delete guard is touched, and only inside the transaction. A reported entry
        // must be unwritable before, during and after — the reset deletes and re-seeds, it never
        // edits, so it has no reason to disarm this one.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        var reported = (await AllEntriesAsync(db)).Single(e => e.ReportedAt is not null);

        var refusal = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlRawAsync(
                "UPDATE entry SET status = 'confirmed' WHERE id = {0}", [reported.Id], Ct));

        refusal.MessageText.ShouldContain("immutable");
    }

    [Fact]
    public async Task The_seeded_ids_come_back_unchanged()
    {
        // The contract with web/teren-pwa/src/app/core/projects/project-source.ts (ARCHITECTURE
        // §6). If a reset handed back different site ids, every POST /api/entries would 404 and
        // captured entries could never leave the phone — a reset that looks like it worked and
        // silently breaks the demo it exists to protect.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        await GivenJunkFromDemosAsync(db, count: 3);

        await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        var companies = await db.Set<Company>().IgnoreQueryFilters()
            .Select(c => c.Id).ToListAsync(Ct);
        companies.ShouldBe([Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000001")]);

        var projects = await db.Set<Project>().IgnoreQueryFilters()
            .Select(p => p.Id).ToListAsync(Ct);
        projects.ShouldBe(
            [
                Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000002"),
                Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000003"),
                Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000004"),
            ],
            ignoreOrder: true);

        var entries = await AllEntriesAsync(db);
        entries.Select(e => e.Id).ShouldBe(
            [
                Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000011"),
                Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000012"),
                Guid.Parse("d3a0c1f0-5b8e-4f1a-9c62-000000000013"),
            ],
            ignoreOrder: true);
        entries.ShouldAllBe(e => e.ProjectId == DemoSeeder.Project1Id);
    }

    [Fact]
    public async Task Resetting_twice_leaves_the_same_state_as_resetting_once()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        await GivenJunkFromDemosAsync(db, count: 4);

        var first = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);
        var second = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        second.FinalState.ShouldBe(first.FinalState);
        second.Removed.ShouldBe(new DemoRowCounts(
            Companies: 1, Projects: 3, Entries: 3, Media: 0, Reports: 0,
            AppUsers: 2, Devices: 1, ActivationCodes: 1, PasswordTokens: 0,
            AdminSessions: 0, AdminAudits: 0));
        second.ReportedEntriesRemoved.ShouldBe(1);
        second.Reseeded.ShouldBe(FullSeedRowCount);
        second.GuardArmed.ShouldBeTrue();
    }

    [Fact]
    public async Task Resetting_a_database_that_was_never_seeded_just_seeds_it()
    {
        await using var db = await app.CreateScratchDatabaseAsync();

        var result = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        result.Removed.Total.ShouldBe(0);
        result.Reseeded.ShouldBe(FullSeedRowCount);
        result.FinalState.ShouldBe(new DemoRowCounts(1, 3, 3, 0, 0, 2, 1, 1, 0, 0, 0));
    }

    [Fact]
    public async Task No_other_company_is_touched_including_its_reported_entries()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        await GivenAnotherCompanyAsync(db);
        await GivenJunkFromDemosAsync(db, count: 2);

        var result = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        result.Removed.Companies.ShouldBe(1);
        result.Removed.Entries.ShouldBe(5);

        (await db.Set<Company>().IgnoreQueryFilters().CountAsync(c => c.Id == OtherCompanyId, Ct))
            .ShouldBe(1);
        (await db.Set<Project>().IgnoreQueryFilters().CountAsync(p => p.Id == OtherProjectId, Ct))
            .ShouldBe(1);

        var survivor = await db.Set<Entry>().IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(e => e.Id == OtherEntryId, Ct);
        survivor.ReportedAt.ShouldNotBeNull();
        survivor.RawTranscript.ShouldBe("tudja evidencija koja se ne dira");
    }

    [Fact]
    public async Task A_correction_chain_is_deleted_leaf_first()
    {
        // fk_entry_supersedes_entry is RESTRICT, so one bulk DELETE can fail purely on the order
        // Postgres picked. ROADMAP C4 will produce these rows for real.
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        var original = Guid.NewGuid();
        var correction = Guid.NewGuid();
        var correctionOfCorrection = Guid.NewGuid();

        db.Set<Entry>().Add(DemoEntry(original, EntryStatus.Reported, reported: true));
        await db.SaveChangesAsync(Ct);

        var second = DemoEntry(correction, EntryStatus.Reported, reported: true);
        second.SupersedesEntryId = original;
        db.Set<Entry>().Add(second);
        await db.SaveChangesAsync(Ct);

        var third = DemoEntry(correctionOfCorrection, EntryStatus.Confirmed);
        third.SupersedesEntryId = correction;
        db.Set<Entry>().Add(third);
        await db.SaveChangesAsync(Ct);
        db.ChangeTracker.Clear();

        var result = await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct);

        result.Removed.Entries.ShouldBe(6);
        (await AllEntriesAsync(db)).Count.ShouldBe(3);
    }

    [Fact]
    public async Task A_failure_during_the_re_seed_restores_both_the_data_and_the_guard()
    {
        // The requirement in one test: "if the reset disables the guard, it must re-enable it
        // inside the same transaction, so a failure anywhere restores the guard along with the
        // data". The failure is injected after every delete has run and before the seed lands.
        var interceptor = new FailOnceInterceptor("INSERT INTO company");
        await using var db = await app.CreateScratchDatabaseAsync(null, interceptor);

        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        await GivenJunkFromDemosAsync(db, count: 2);
        db.ChangeTracker.Clear();

        interceptor.Arm();

        await Should.ThrowAsync<Exception>(async () =>
            await DemoReset.ResetAsync(db, deviceToken: DemoDeviceToken, ct: Ct));

        interceptor.Fired.ShouldBeTrue("the failure was never injected, so nothing was proven");
        db.ChangeTracker.Clear();

        // The data the founder had is still there — five entries, not three and not zero.
        var entries = await AllEntriesAsync(db);
        entries.Count.ShouldBe(5);
        entries.Select(e => e.Id).ShouldContain(DemoSeeder.Entry1Id);
        (await db.Set<Company>().IgnoreQueryFilters().CountAsync(Ct)).ShouldBe(1);

        // And the guard came back with it, without anybody re-running anything.
        var reported = entries.First(e => e.ReportedAt is not null);
        await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlRawAsync(
                "DELETE FROM entry WHERE id = {0}", [reported.Id], Ct));
    }

    // ---------------------------------------------------------------- objects and jobs

    [Fact]
    public async Task Only_the_demo_company_prefix_is_swept_from_the_bucket()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);

        var objects = new FakeDemoObjectPurge();
        objects.Put(
            $"company/{DemoSeeder.CompanyId:D}/project/x/entry/y/a.jpg",
            $"company/{DemoSeeder.CompanyId:D}/project/x/entry/y/report.pdf",
            $"company/{OtherCompanyId:D}/project/x/entry/y/b.jpg");

        var result = await DemoReset.ResetAsync(db, objects, deviceToken: DemoDeviceToken, ct: Ct);

        objects.PrefixesListed.ShouldAllBe(p => p == DemoReset.ObjectPrefix);
        result.ObjectsRemoved.ShouldBe(2);
        result.ObjectsUnavailable.ShouldBeNull();
        objects.Remaining.ShouldBe([$"company/{OtherCompanyId:D}/project/x/entry/y/b.jpg"]);
    }

    [Fact]
    public async Task A_second_reset_finds_nothing_left_in_the_bucket()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        var objects = new FakeDemoObjectPurge();
        objects.Put($"company/{DemoSeeder.CompanyId:D}/project/x/entry/y/a.jpg");

        (await DemoReset.ResetAsync(db, objects, deviceToken: DemoDeviceToken, ct: Ct)).ObjectsRemoved.ShouldBe(1);
        (await DemoReset.ResetAsync(db, objects, deviceToken: DemoDeviceToken, ct: Ct)).ObjectsRemoved.ShouldBe(0);
    }

    [Fact]
    public async Task An_unreachable_bucket_is_reported_not_thrown()
    {
        // By the time the bucket is swept the database work is committed. Turning "the leftovers
        // could not be swept" into a failed command would tell the founder his demo is broken
        // when it is fine.
        await using var db = await app.CreateScratchDatabaseAsync();
        var objects = new FakeDemoObjectPurge { Fault = new HttpRequestException("no route to host") };

        var result = await DemoReset.ResetAsync(db, objects, deviceToken: DemoDeviceToken, ct: Ct);

        result.Reseeded.ShouldBe(FullSeedRowCount);
        result.ObjectsRemoved.ShouldBe(0);
        result.ObjectsUnavailable.ShouldNotBeNull().ShouldContain("no route to host");
        result.GuardArmed.ShouldBeTrue();
    }

    [Fact]
    public async Task Pending_jobs_are_purged_and_counted()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        var jobs = new FakeDemoJobPurge();
        jobs.Enqueue("101", "102", "103");

        var result = await DemoReset.ResetAsync(db, jobs: jobs, deviceToken: DemoDeviceToken, ct: Ct);

        result.JobsRemoved.ShouldBe(3);
        result.JobsUnavailable.ShouldBeNull();
        jobs.Pending.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_process_without_a_job_server_says_so_instead_of_claiming_zero()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        var jobs = new FakeDemoJobPurge { Unavailable = "Hangfire is switched off" };
        jobs.Enqueue("101");

        var result = await DemoReset.ResetAsync(db, jobs: jobs, deviceToken: DemoDeviceToken, ct: Ct);

        result.JobsRemoved.ShouldBe(0);
        result.JobsUnavailable.ShouldBe("Hangfire is switched off");
        jobs.Deleted.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_dry_run_reports_what_is_there_and_destroys_nothing()
    {
        await using var db = await app.CreateScratchDatabaseAsync();
        await DemoSeeder.SeedAsync(db, DemoDeviceToken, Ct);
        await GivenJunkFromDemosAsync(db, count: 5);

        var objects = new FakeDemoObjectPurge();
        objects.Put($"company/{DemoSeeder.CompanyId:D}/project/x/entry/y/a.jpg");
        var jobs = new FakeDemoJobPurge();
        jobs.Enqueue("101", "102");

        var plan = await DemoReset.InspectAsync(db, objects, jobs, Ct);

        plan.Present.ShouldBe(new DemoRowCounts(
            Companies: 1, Projects: 3, Entries: 8, Media: 5, Reports: 5,
            AppUsers: 2, Devices: 1, ActivationCodes: 1, PasswordTokens: 0,
            AdminSessions: 0, AdminAudits: 0));
        plan.ReportedEntries.ShouldBe(6);
        plan.Objects.ShouldBe(1);
        plan.PendingJobs.ShouldBe(2);

        // Nothing moved.
        (await AllEntriesAsync(db)).Count.ShouldBe(8);
        objects.KeysDeleted.ShouldBeEmpty();
        jobs.Deleted.ShouldBeEmpty();
    }

    // ---------------------------------------------------------------- arrange helpers

    /// <summary>
    /// What a demo actually leaves behind: an entry with a photograph, confirmed, reported and
    /// therefore sealed by the delete guard — the exact rows <c>seed</c> can never remove.
    /// </summary>
    private static async Task GivenJunkFromDemosAsync(TerenDbContext db, int count)
    {
        var now = DateTime.UtcNow;

        for (var i = 0; i < count; i++)
        {
            var entryId = Guid.NewGuid();
            var mediaId = Guid.NewGuid();

            db.Set<Entry>().Add(DemoEntry(entryId, EntryStatus.Reported, reported: true));
            db.Set<Media>().Add(new Media
            {
                Id = mediaId,
                CompanyId = DemoSeeder.CompanyId,
                EntryId = entryId,
                Kind = MediaKind.Photo,
                ObjectKey = ObjectKeys.ForMedia(
                    DemoSeeder.CompanyId, DemoSeeder.Project1Id, entryId, mediaId, "jpg"),
                ContentType = "image/jpeg",
                ByteSize = 1024,
                Sha256 = new string('a', 64),
                UploadStatus = MediaUploadStatus.Verified,
                CreatedAt = now,
            });
            db.Set<Report>().Add(new Report
            {
                Id = Guid.NewGuid(),
                CompanyId = DemoSeeder.CompanyId,
                ProjectId = DemoSeeder.Project1Id,
                EntryId = entryId,
                Kind = ReportKind.Daily,
                PeriodStart = DateOnly.FromDateTime(now),
                PeriodEnd = DateOnly.FromDateTime(now),
                PdfObjectKey = ObjectKeys.ForEntryReport(
                    DemoSeeder.CompanyId, DemoSeeder.Project1Id, entryId),
                Status = ReportStatus.Sent,
                SentAt = now,
                Attempts = 1,
                CreatedAt = now,
            });
        }

        await db.SaveChangesAsync(Ct);
        db.ChangeTracker.Clear();
    }

    private static Entry DemoEntry(Guid id, EntryStatus status, bool reported = false)
    {
        var now = DateTime.UtcNow;

        return new Entry
        {
            Id = id,
            CompanyId = DemoSeeder.CompanyId,
            ProjectId = DemoSeeder.Project1Id,
            EntryDate = DateOnly.FromDateTime(now),
            Status = status,
            RawTranscript = "test test",
            CreatedAt = now,
            ReceivedAt = now,
            ConfirmedAt = reported ? now : null,
            ReportedAt = reported ? now : null,
        };
    }

    private static async Task GivenAnotherCompanyAsync(TerenDbContext db)
    {
        var now = DateTime.UtcNow;

        db.Set<Company>().Add(new Company
        {
            Id = OtherCompanyId, Name = "Druga firma d.o.o.", CreatedAt = now,
        });
        db.Set<Project>().Add(new Project
        {
            Id = OtherProjectId,
            CompanyId = OtherCompanyId,
            Name = "Gradilište druge firme",
            ReportLanguage = "sr",
            CreatedAt = now,
        });
        db.Set<Entry>().Add(new Entry
        {
            Id = OtherEntryId,
            CompanyId = OtherCompanyId,
            ProjectId = OtherProjectId,
            EntryDate = DateOnly.FromDateTime(now),
            Status = EntryStatus.Reported,
            RawTranscript = "tudja evidencija koja se ne dira",
            CreatedAt = now,
            ReceivedAt = now,
            ConfirmedAt = now,
            ReportedAt = now,
        });

        await db.SaveChangesAsync(Ct);
        db.ChangeTracker.Clear();
    }

    private static async Task<List<Entry>> AllEntriesAsync(TerenDbContext db) =>
        await db.Set<Entry>().IgnoreQueryFilters().AsNoTracking()
            .Where(e => e.CompanyId == DemoSeeder.CompanyId)
            .ToListAsync(Ct);
}
