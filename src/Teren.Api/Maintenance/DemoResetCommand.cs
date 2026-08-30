using Microsoft.EntityFrameworkCore;
using Teren.Infrastructure.Persistence;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Maintenance;

/// <summary>
/// The terminal half of <c>reset-demo</c>: ask <see cref="DemoResetGuard"/> whether this is
/// allowed, then either report what would happen or make it happen and say exactly what it did.
/// <para>
/// Everything printed here is written for the founder reading it over SSH at midnight, which is
/// the case the guard exists for. It names the database and the company before it touches
/// anything, and it ends by stating the immutability guard's real state — read back out of
/// <c>pg_trigger</c>, not assumed from having issued a statement.
/// </para>
/// </summary>
public static class DemoResetCommand
{
    public static async Task<int> RunAsync(WebApplication app, string[] args)
    {
        var decision = DemoResetGuard.Evaluate(
            app.Environment.EnvironmentName,
            app.Configuration.GetValue(DemoResetGuard.EnabledSetting, defaultValue: false),
            args);

        Console.WriteLine();
        Console.WriteLine(decision.Message);
        Console.WriteLine();

        if (decision.Verdict == DemoResetVerdict.Refused)
        {
            return decision.ExitCode;
        }

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TerenDbContext>();

        // Resolving either purge can throw — a mistyped Storage__SecretKey on a staging box fails
        // S3DemoObjectPurge's constructor, and a Hangfire storage that will not open fails the
        // other. Neither is a reason to refuse to reset the demo: the database work is the point,
        // and the sweep is cleanup. So a purge that cannot even be built is turned into one that
        // reports why, exactly like a bucket that cannot be reached.
        var objects = Resolve<IDemoObjectPurge>(scope, fault => new FaultedObjectPurge(fault));
        var jobs = Resolve<IDemoJobPurge>(scope, fault => new FaultedJobPurge(fault));

        // Same first step as `seed`: a box that has never been migrated is a box that cannot be
        // reset, and the failure would otherwise be a bare Npgsql "column does not exist".
        await db.Database.MigrateAsync();

        Console.WriteLine($"  database    {Describe(db)}");
        Console.WriteLine($"  company     {DemoReset.CompanyId:D} (the seeded demo company)");
        Console.WriteLine($"  objects     {DemoReset.ObjectPrefix}");
        Console.WriteLine();

        if (decision.Verdict == DemoResetVerdict.DryRun)
        {
            var plan = await DemoReset.InspectAsync(db, objects, jobs);

            Console.WriteLine("Would remove:");
            WriteRows(plan.Present, plan.ReportedEntries);
            Console.WriteLine($"  objects     {Or(plan.Objects, plan.ObjectsUnavailable)}");
            Console.WriteLine(
                $"  jobs        {Or(plan.PendingJobs, plan.JobsUnavailable, "pending")}");
            Console.WriteLine();
            Console.WriteLine("Would then re-seed the demo company, its three sites and three entries.");
            Console.WriteLine();

            return decision.ExitCode;
        }

        var result = await DemoReset.ResetAsync(db, objects, jobs);

        Console.WriteLine("Removed:");
        WriteRows(result.Removed, result.ReportedEntriesRemoved);
        Console.WriteLine($"  objects     {Or(result.ObjectsRemoved, result.ObjectsUnavailable)}");
        Console.WriteLine(
            "  jobs        " + Or(
                result.JobsRemoved,
                result.JobsUnavailable,
                "pending (the recurring sweep and the job history were left alone)"));
        Console.WriteLine();
        Console.WriteLine($"Re-seeded: {result.Reseeded} row(s).");
        Console.WriteLine("Final state:");
        Console.WriteLine($"  companies   {result.FinalState.Companies}");
        Console.WriteLine($"  sites       {result.FinalState.Projects}");
        Console.WriteLine($"  entries     {result.FinalState.Entries}");
        Console.WriteLine($"  media       {result.FinalState.Media}");
        Console.WriteLine($"  reports     {result.FinalState.Reports}");
        Console.WriteLine("  site ids    " + string.Join(", ", new[]
        {
            DemoSeeder.Project1Id, DemoSeeder.Project2Id, DemoSeeder.Project3Id,
        }));
        Console.WriteLine();
        Console.WriteLine(result.GuardArmed
            ? "Immutability guard trg_entry_guard_delete: ARMED (read back from pg_trigger)."
            : "Immutability guard trg_entry_guard_delete: NOT ARMED — do not use this database.");
        Console.WriteLine();

        if (jobs?.Unavailable is null)
        {
            // Not a caveat about the reset — a statement about what a live host does next, so a
            // job appearing seconds later does not read as the reset having failed.
            Console.WriteLine(
                "A running API will re-queue anything the seeded demo genuinely still needs "
                + "within a minute, via the pipeline sweep.");
            Console.WriteLine();
        }

        return result.GuardArmed ? decision.ExitCode : 1;
    }

    private static void WriteRows(DemoRowCounts counts, int reportedEntries)
    {
        Console.WriteLine($"  reports     {counts.Reports}");
        Console.WriteLine($"  media       {counts.Media}");
        Console.WriteLine(
            $"  entries     {counts.Entries}"
            + (reportedEntries > 0
                ? $"  ({reportedEntries} of them reported, i.e. immutable in normal operation)"
                : string.Empty));
        Console.WriteLine($"  sites       {counts.Projects}");
        Console.WriteLine($"  companies   {counts.Companies}");
    }

    /// <summary>The host and database, never the password.</summary>
    private static string Describe(DbContext db)
    {
        var builder = new Npgsql.NpgsqlConnectionStringBuilder(
            db.Database.GetConnectionString() ?? string.Empty);

        return $"{builder.Database} on {builder.Host}:{builder.Port}";
    }

    /// <summary>A count with its unit, or the reason there is no count — never both.</summary>
    private static T? Resolve<T>(IServiceScope scope, Func<Exception, T> onFault) where T : class
    {
        try
        {
            return scope.ServiceProvider.GetService<T>();
        }
        catch (Exception ex)
        {
            return onFault(ex);
        }
    }

    /// <summary>A bucket that could not even be constructed, reported through the same path as
    /// one that could not be reached.</summary>
    private sealed class FaultedObjectPurge(Exception fault) : IDemoObjectPurge
    {
        public Task<IReadOnlyList<string>> ListAsync(string prefix, CancellationToken ct = default) =>
            throw fault;

        public Task<int> DeleteAsync(IReadOnlyList<string> keys, CancellationToken ct = default) =>
            throw fault;
    }

    /// <summary>The same for the job queue, which already has a word for "cannot do anything".</summary>
    private sealed class FaultedJobPurge(Exception fault) : IDemoJobPurge
    {
        public string? Unavailable => fault.Message;

        public Task<IReadOnlyList<string>> ListPendingAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<string>>([]);

        public Task<int> DeleteAsync(IReadOnlyList<string> jobIds, CancellationToken ct = default) =>
            Task.FromResult(0);
    }

    /// <summary>A count with its unit, or the reason there is no count — never both.</summary>
    private static string Or(int count, string? unavailable, string suffix = "") =>
        unavailable is not null
            ? $"— not swept: {unavailable}"
            : suffix.Length == 0 ? count.ToString() : $"{count} {suffix}";
}
