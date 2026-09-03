using Microsoft.Extensions.Options;
using Teren.Infrastructure.Tenancy;
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
        var identityDb = scope.ServiceProvider.GetRequiredService<TerenIdentityDbContext>();

        // Resolving either purge can throw — a mistyped Storage__SecretKey on a staging box fails
        // S3DemoObjectPurge's constructor, and a Hangfire storage that will not open fails the
        // other. Neither is a reason to refuse to reset the demo: the database work is the point,
        // and the sweep is cleanup. So a purge that cannot even be built is turned into one that
        // reports why, exactly like a bucket that cannot be reached.
        var objects = Resolve<IDemoObjectPurge>(scope, fault => new FaultedObjectPurge(fault));
        var jobs = Resolve<IDemoJobPurge>(scope, fault => new FaultedJobPurge(fault));

        // Same first step as `seed`, and BOTH histories, in the same order Program.cs uses:
        // device.company_id and app_user.company_id reference the company table the evidence model
        // owns. Migrating only one of them is how this command came to die on a bare Npgsql
        // 42P01 "relation app_user does not exist" against a pre-D1 database — on the no-flag dry
        // run, which is the safe default and the thing reached for when a demo is broken and a
        // customer is in the room.
        await db.Database.MigrateAsync();
        await identityDb.Database.MigrateAsync();

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
            Console.WriteLine(
                "Would then re-seed the demo company: three sites, three entries, the owner and "
                + "the foreman, and the demo phone (its credential restored from "
                + "Auth:DeviceToken).");
            Console.WriteLine();

            return decision.ExitCode;
        }

        // Same rule as `seed`, from the same function: the published code exists on a Development
        // host and nowhere else. This command is reachable on a deployed box through
        // Demo:ResetEnabled, which is exactly where hardcoding it would have put it back.
        var useFixedDemoCode = DemoSeeder.UsesFixedActivationCode(app.Environment.EnvironmentName);

        var result = await DemoReset.ResetAsync(
            db, objects, jobs, DeviceTokenOf(app), useFixedDemoCode);

        Console.WriteLine("Removed:");
        WriteRows(result.Removed, result.ReportedEntriesRemoved);
        Console.WriteLine($"  objects     {Or(result.ObjectsRemoved, result.ObjectsUnavailable)}");
        Console.WriteLine(
            "  jobs        " + Or(
                result.JobsRemoved,
                result.JobsUnavailable,
                "pending (the recurring sweep and the job history were left alone)"));
        Console.WriteLine();
        // "written", not "inserted": the count includes the withdrawal stamps the re-seed cleared
        // on rows that already existed (see DemoSeeder.SeedIdentityAsync).
        Console.WriteLine($"Re-seeded: {result.Reseeded} row(s) written.");
        Console.WriteLine("Final state:");
        Console.WriteLine($"  companies   {result.FinalState.Companies}");
        Console.WriteLine($"  sites       {result.FinalState.Projects}");
        Console.WriteLine($"  entries     {result.FinalState.Entries}");
        Console.WriteLine($"  media       {result.FinalState.Media}");
        Console.WriteLine($"  reports     {result.FinalState.Reports}");
        Console.WriteLine($"  users       {result.FinalState.AppUsers}");
        Console.WriteLine($"  devices     {result.FinalState.Devices}");
        Console.WriteLine("  site ids    " + string.Join(", ", new[]
        {
            DemoSeeder.Project1Id, DemoSeeder.Project2Id, DemoSeeder.Project3Id,
        }));
        Console.WriteLine(
            "  activation  " + (result.ActivationCode is { } code
                ? $"username {DemoSeeder.WorkerUsername}, code {code}"
                : $"username {DemoSeeder.WorkerUsername}, and the live code's plaintext is not "
                  + "stored — issue him a new one from /company"));

        if (!useFixedDemoCode && result.ActivationCode is not null)
        {
            // A reset deletes every activation code the demo company had, so this one was drawn
            // seconds ago and exists in this scrollback and in the database. Nowhere else — but
            // it is still readable (`seed` prints it, /company shows it), which is why this says
            // "note it" rather than "this is your only chance".
            Console.WriteLine(
                "              That code was drawn for this host, not taken from the repository. "
                + "Note it: nothing outside this database holds a copy.");
        }

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


    /// <summary>
    /// The demo device's token, so the re-seed provisions a phone that can actually authenticate.
    /// Read from configuration rather than passed in, because a reset that restored the demo data
    /// but not its credential would look like a success and behave like a dead demo.
    /// <para>
    /// An empty value is legitimate — it is the D7 end state — but it is never silent here.
    /// Program.cs warns loudly about exactly this state at start-up, and a one-shot command that
    /// prints a full report of what it did should not be the place the founder discovers his
    /// freshly reset demo has no phone.
    /// </para>
    /// </summary>
    private static string DeviceTokenOf(WebApplication app)
    {
        var token = app.Services
            .GetRequiredService<IOptions<DeviceAuthOptions>>().Value.DeviceToken;

        if (string.IsNullOrWhiteSpace(token))
        {
            Console.WriteLine(
                "  NOTE        Auth:DeviceToken is empty, so this reset provisions NO demo device "
                + "and every device bearer token will be rejected. Set Auth__DeviceToken and run "
                + "`seed` if this host is meant to run the demo.");
            Console.WriteLine();
        }

        return token;
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
        Console.WriteLine($"  devices     {counts.Devices}");
        Console.WriteLine($"  users       {counts.AppUsers}");
        Console.WriteLine($"  codes       {counts.ActivationCodes}");
        Console.WriteLine($"  sessions    {counts.AdminSessions + counts.PasswordTokens}");
        Console.WriteLine($"  audit rows  {counts.AdminAudits}");
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
