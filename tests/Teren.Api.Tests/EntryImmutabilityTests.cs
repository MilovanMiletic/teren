using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// Invariant 6 (PROJECT.md principle 2, ARCHITECTURE §6, §12): a reported entry never changes
/// and never disappears, and the raw transcript is write-once from the moment it exists.
/// <para>
/// Every rule here is asserted twice — once through EF, which is what makes application code
/// fail fast with a readable message, and once through raw SQL that bypasses
/// <see cref="Microsoft.EntityFrameworkCore.DbContext.SaveChanges()"/> entirely and reaches the
/// Postgres trigger. Testing only the EF half would prove half the promise: the half that any
/// future migration script, psql session or ORM change walks straight around.
/// </para>
/// </summary>
public sealed class EntryImmutabilityTests(TerenTestApp app) : ApiTestBase(app)
{
    private async Task<Guid> GivenReportedEntryAsync(string? transcript = "Danas smo radili razvod.")
    {
        var id = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            id, TestIds.CompanyA, TestIds.ProjectA1,
            EntryStatus.Reported, DateTime.UtcNow.AddHours(-1), transcript));
        return id;
    }

    // ------------------------------------------------------------ application layer

    [Fact]
    public async Task Ef_refuses_to_update_a_reported_entry()
    {
        var entryId = await GivenReportedEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
        entry.FailureReason = "tampered";

        var ex = await Should.ThrowAsync<InvalidOperationException>(
            async () => await db.SaveChangesAsync(Ct));
        ex.Message.ShouldContain("immutable");
        ex.Message.ShouldContain("SupersedesEntryId");

        (await LoadEntryAsync(entryId))!.FailureReason.ShouldBeNull();
    }

    [Fact]
    public async Task Ef_refuses_to_delete_a_reported_entry()
    {
        var entryId = await GivenReportedEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        db.Entries.Remove(await db.Entries.FirstAsync(e => e.Id == entryId, Ct));

        await Should.ThrowAsync<InvalidOperationException>(
            async () => await db.SaveChangesAsync(Ct));

        (await LoadEntryAsync(entryId)).ShouldNotBeNull();
    }

    [Fact]
    public async Task Ef_refuses_to_rewrite_a_raw_transcript_even_before_reporting()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1,
            rawTranscript: "Danas smo radili razvod."));

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
        entry.RawTranscript = "Nesto sasvim drugo.";

        var ex = await Should.ThrowAsync<InvalidOperationException>(
            async () => await db.SaveChangesAsync(Ct));
        ex.Message.ShouldContain("write-once");

        (await LoadEntryAsync(entryId))!.RawTranscript.ShouldBe("Danas smo radili razvod.");
    }

    [Fact]
    public async Task Ef_refuses_to_erase_a_raw_transcript()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1, rawTranscript: "Evidence."));

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
        entry.RawTranscript = null;

        await Should.ThrowAsync<InvalidOperationException>(
            async () => await db.SaveChangesAsync(Ct));
    }

    [Fact]
    public async Task Writing_the_first_transcript_is_allowed()
    {
        // The rule is write-once, not write-never: B4 has to be able to put the transcript there.
        var entryId = await GivenEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
        entry.RawTranscript = "Prvi put upisano.";
        entry.Status = EntryStatus.AwaitingConfirmation;
        await db.SaveChangesAsync(Ct);

        (await LoadEntryAsync(entryId))!.RawTranscript.ShouldBe("Prvi put upisano.");
    }

    [Fact]
    public async Task An_unreported_entry_is_ordinarily_updatable()
    {
        // The guard must block what it is meant to block and nothing else — a test suite that
        // only proves refusals would pass against a database that refuses everything.
        var entryId = await GivenEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var entry = await db.Entries.FirstAsync(e => e.Id == entryId, Ct);
        entry.Status = EntryStatus.Processing;
        await db.SaveChangesAsync(Ct);

        (await LoadEntryAsync(entryId))!.Status.ShouldBe(EntryStatus.Processing);
    }

    // ------------------------------------------------------------ the Postgres trigger

    [Fact]
    public async Task The_trigger_rejects_an_update_that_bypasses_ef()
    {
        var entryId = await GivenReportedEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE entry SET failure_reason = 'tampered' WHERE id = {entryId}", Ct));

        ex.MessageText.ShouldContain("is immutable");
        (await LoadEntryAsync(entryId))!.FailureReason.ShouldBeNull();
    }

    [Fact]
    public async Task The_trigger_rejects_a_delete_that_bypasses_ef()
    {
        var entryId = await GivenReportedEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"DELETE FROM entry WHERE id = {entryId}", Ct));

        ex.MessageText.ShouldContain("cannot be deleted");
        (await LoadEntryAsync(entryId)).ShouldNotBeNull();
    }

    [Fact]
    public async Task The_trigger_rejects_clearing_reported_at_to_unlock_a_row()
    {
        // The obvious attack on a trigger keyed to OLD.reported_at: null it out first. OLD is
        // what the trigger reads, so this fails too.
        var entryId = await GivenReportedEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE entry SET reported_at = NULL WHERE id = {entryId}", Ct));

        (await LoadEntryAsync(entryId))!.ReportedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task The_trigger_rejects_rewriting_a_raw_transcript_on_an_open_entry()
    {
        var entryId = Guid.NewGuid();
        await InsertEntryAsync(NewEntry(
            entryId, TestIds.CompanyA, TestIds.ProjectA1, rawTranscript: "Original."));

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE entry SET raw_transcript = 'Izmenjeno' WHERE id = {entryId}", Ct));

        ex.MessageText.ShouldContain("write-once");
        (await LoadEntryAsync(entryId))!.RawTranscript.ShouldBe("Original.");
    }

    [Fact]
    public async Task The_trigger_allows_the_first_transcript_and_ordinary_updates()
    {
        var entryId = await GivenEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var affected = await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE entry SET raw_transcript = 'Prvi upis', status = 'processing' WHERE id = {entryId}",
            Ct);

        affected.ShouldBe(1);
        var entry = await LoadEntryAsync(entryId);
        entry!.RawTranscript.ShouldBe("Prvi upis");
        entry.Status.ShouldBe(EntryStatus.Processing);
    }

    [Fact]
    public async Task A_reported_entry_is_still_readable_and_still_supersedable()
    {
        // Immutable is not unreachable: a correction is a new entry pointing back at this one.
        var reportedId = await GivenReportedEntryAsync();
        var correctionId = Guid.NewGuid();

        await using (var db = App.CreateDbContext(TestIds.CompanyA))
        {
            var correction = NewEntry(correctionId, TestIds.CompanyA, TestIds.ProjectA1);
            correction.SupersedesEntryId = reportedId;
            db.Entries.Add(correction);
            await db.SaveChangesAsync(Ct);
        }

        var response = await Client.Get($"/api/entries/{reportedId}");
        response.EnsureSuccessStatusCode();

        var correctionResponse = await (await Client.Get($"/api/entries/{correctionId}")).JsonAsync();
        correctionResponse.GetGuid("supersedes_entry_id").ShouldBe(reportedId);
    }

    // ------------------------------------------------------------ schema guards

    [Fact]
    public async Task Structure_json_without_a_schema_version_is_rejected_by_the_check_constraint()
    {
        var entryId = await GivenEntryAsync();

        const string withoutSchemaVersion = """{"work_done": []}""";

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE entry SET structure = {withoutSchemaVersion}::jsonb WHERE id = {entryId}",
                Ct));

        ex.ConstraintName.ShouldBe("ck_entry_structure_schema_version");
    }

    [Fact]
    public async Task A_status_outside_the_state_machine_is_rejected_by_the_check_constraint()
    {
        var entryId = await GivenEntryAsync();

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE entry SET status = 'invented' WHERE id = {entryId}", Ct));

        ex.ConstraintName.ShouldBe("ck_entry_status");
    }

    [Fact]
    public async Task Evidence_is_never_cascade_deleted()
    {
        // Every FK is ON DELETE RESTRICT: deleting a project with entries under it must fail,
        // not quietly take the diary with it.
        var entryId = await GivenEntryAsync();
        entryId.ShouldNotBe(Guid.Empty);

        await using var db = App.CreateDbContext(TestIds.CompanyA);
        var ex = await Should.ThrowAsync<PostgresException>(async () =>
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"DELETE FROM project WHERE id = {TestIds.ProjectA1}", Ct));

        ex.SqlState.ShouldBe(PostgresErrorCodes.ForeignKeyViolation);
    }
}
