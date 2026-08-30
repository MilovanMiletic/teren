namespace Teren.Infrastructure.Seeding;

/// <summary>What the guard decided about one invocation of <c>reset-demo</c>.</summary>
public enum DemoResetVerdict
{
    /// <summary>The command does not run. The message says why, and how to make it legal.</summary>
    Refused,

    /// <summary>Report what would be destroyed; destroy nothing.</summary>
    DryRun,

    /// <summary>Run the reset.</summary>
    Proceed,
}

/// <summary>
/// The verdict, the exact words to put on the terminal before anything happens, and the exit
/// code the process should end with.
/// <para>
/// The exit code is part of the decision rather than something the caller re-derives, because
/// the two dry runs mean different things to a script: <c>--dry-run</c> was asked for and
/// delivered (0), while a bare <c>reset-demo</c> asked for a reset and did not get one (2).
/// </para>
/// </summary>
public sealed record DemoResetDecision(DemoResetVerdict Verdict, string Message, int ExitCode);

/// <summary>
/// Everything that has to be true before <c>reset-demo</c> is allowed to delete anything, as a
/// pure function of the environment name, one configuration flag and the argv the founder typed.
/// <para>
/// It is a separate, argument-free-of-I/O type on purpose: the refusal is the safety mechanism,
/// so it is the part that must be provable without a database, a bucket or a host. A guard that
/// could only be exercised by actually running the destructive command would be a guard nobody
/// tests.
/// </para>
/// <para>
/// Three independent conditions, and all three have to hold (the company scope is the fourth and
/// lives in <see cref="DemoReset"/>, because it is enforced by a WHERE clause and a post-delete
/// assertion rather than by argv):
/// </para>
/// <list type="number">
/// <item><b>The command is named.</b> There is no ambient default and no short alias — the word
/// <c>reset-demo</c> has to be typed.</item>
/// <item><b>The host says it is a demo host.</b> Either <c>ASPNETCORE_ENVIRONMENT=Development</c>,
/// or the host explicitly carries <c>Demo:ResetEnabled=true</c>. The second condition exists
/// because staging — the box the distributor actually demos from — runs with
/// <c>ASPNETCORE_ENVIRONMENT=Production</c> (deploy/docker-compose.prod.yml), so the environment
/// name alone cannot tell the demo host from a real one. A production host that never sets the
/// flag is refused by default, which is the direction the mistake has to fail in.</item>
/// <item><b>The destruction is spelled out.</b> <c>--yes-delete-demo-data</c>, whose name says
/// what happens, rather than a <c>-f</c> or a <c>-y</c> that could be muscle memory from another
/// command. Without it the command reports what it *would* destroy and exits without touching
/// anything — so the natural way to discover this command is also the safe way.</item>
/// </list>
/// </summary>
public static class DemoResetGuard
{
    /// <summary>The verb, typed in full.</summary>
    public const string CommandName = "reset-demo";

    /// <summary>The flag that turns a dry run into a deletion. Named for its effect.</summary>
    public const string ConfirmFlag = "--yes-delete-demo-data";

    /// <summary>Asks for the report without asking for the deletion. The default anyway; this
    /// makes the intent explicit and makes the exit code 0 rather than a refusal.</summary>
    public const string DryRunFlag = "--dry-run";

    /// <summary>Configuration key (<c>Demo__ResetEnabled</c> as an environment variable) that
    /// marks a non-Development host as a demo host.</summary>
    public const string EnabledSetting = "Demo:ResetEnabled";

    /// <summary>The one environment name that implies a demo host without any extra setting.</summary>
    public const string DevelopmentEnvironment = "Development";

    /// <summary>
    /// Decides whether this invocation may destroy anything.
    /// </summary>
    /// <param name="environmentName"><c>IHostEnvironment.EnvironmentName</c>.</param>
    /// <param name="resetEnabled">The bound value of <see cref="EnabledSetting"/>.</param>
    /// <param name="args">The process arguments, verbatim.</param>
    public static DemoResetDecision Evaluate(
        string? environmentName, bool resetEnabled, IReadOnlyList<string> args)
    {
        ArgumentNullException.ThrowIfNull(args);

        if (!Has(args, CommandName))
        {
            return new DemoResetDecision(
                DemoResetVerdict.Refused,
                $"`{CommandName}` was not asked for; nothing was reset.",
                ExitCode: 2);
        }

        var isDevelopment = string.Equals(
            environmentName, DevelopmentEnvironment, StringComparison.OrdinalIgnoreCase);

        if (!isDevelopment && !resetEnabled)
        {
            // Deliberately refused *before* the dry run: on a host that has not declared itself
            // a demo host, this command does not exist at all — it does not even read.
            return new DemoResetDecision(
                DemoResetVerdict.Refused,
                $"REFUSED: `{CommandName}` destroys data and this host has not been declared a "
                + $"demo host. ASPNETCORE_ENVIRONMENT is \"{environmentName ?? "(unset)"}\", not "
                + $"\"{DevelopmentEnvironment}\", and {EnabledSetting} is not true. If this really "
                + $"is the demo/staging box, set Demo__ResetEnabled=true on it. Never set that on "
                + "a host that carries a real contractor's entries.",
                ExitCode: 2);
        }

        var host = isDevelopment
            ? $"environment \"{environmentName}\""
            : $"environment \"{environmentName}\" with {EnabledSetting}=true";

        if (Has(args, DryRunFlag))
        {
            return new DemoResetDecision(
                DemoResetVerdict.DryRun,
                $"Dry run on {host}. Nothing will be deleted.",
                ExitCode: 0);
        }

        if (!Has(args, ConfirmFlag))
        {
            return new DemoResetDecision(
                DemoResetVerdict.DryRun,
                $"""
                 No `{ConfirmFlag}`, so this is a dry run on {host} and nothing will be deleted.

                 `{CommandName}` PERMANENTLY DELETES every row and every stored object belonging
                 to the demo company {DemoSeeder.CompanyId:D} — including entries that were
                 reported and are otherwise immutable — and then re-seeds the demo from scratch.
                 No other company is touched.

                 To actually do it:
                     dotnet run --project src/Teren.Api -- {CommandName} {ConfirmFlag}
                 """,
                ExitCode: 2);
        }

        return new DemoResetDecision(
            DemoResetVerdict.Proceed,
            $"Resetting the demo company {DemoSeeder.CompanyId:D} on {host}.",
            ExitCode: 0);
    }

    private static bool Has(IReadOnlyList<string> args, string token)
    {
        for (var i = 0; i < args.Count; i++)
        {
            if (string.Equals(args[i], token, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
