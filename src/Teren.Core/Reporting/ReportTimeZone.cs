namespace Teren.Core.Reporting;

/// <summary>
/// A project's wall-clock zone, resolved from the IANA id on <c>project.time_zone</c>.
/// <para>
/// **UTC stays the storage format everywhere** (ARCHITECTURE §6: every <c>timestamptz</c> column
/// is UTC). This type exists only at the moment a timestamp is printed for a human, because
/// "07:12 UTC" on a document a Belgrade investor reads is an hour or two away from the time his
/// foreman was actually on site, and an evidence document that is off by an hour invites exactly
/// the argument it exists to prevent.
/// </para>
/// <para>
/// **IANA ids, on both Windows and Linux.** .NET accepts IANA ids on Windows by mapping them
/// through ICU, so <c>Europe/Belgrade</c> resolves on the founder's machine and on a Hetzner
/// container alike — verified on this machine under .NET 10.0.8 (Windows 11), where it also
/// honours DST: 12:00 UTC renders +02:00 in August and +01:00 in January.
/// </para>
/// <para>
/// The mapping works in both directions from .NET 8 — a Windows id such as <c>Central European
/// Standard Time</c> resolves here too, and <c>ReportLocalTimeTests</c> pins that rather than
/// asserting a portability trap that no longer exists. IANA is still what this column is
/// specified in and what <see cref="Default"/> uses, because it is the portable vocabulary and
/// the one every other system in this stack speaks; it is a convention, not something enforced
/// here. What <em>is</em> enforced is that an id nobody can resolve stops the report.
/// </para>
/// <para>
/// Both mappings need ICU. A host built with invariant globalization resolves nothing, which is
/// why <c>ReportLocalTimeTests</c> asserts the default id actually resolves rather than assuming
/// it — a container that lost ICU would otherwise be discovered by a client, not by the suite.
/// </para>
/// </summary>
public static class ReportTimeZone
{
    /// <summary>The market's zone, and the column's default. Serbia keeps one zone, so this is
    /// right for every project until a contractor works across a border.</summary>
    public const string Default = "Europe/Belgrade";

    /// <summary>
    /// Resolves the zone, or throws.
    /// <para>
    /// **Never falls back to UTC.** A zone nobody can resolve is a configuration mistake, and the
    /// two ways to handle one are to stop or to print a time that is quietly wrong. On a document
    /// a client relies on in a dispute, a wrong timestamp is worse than a missing report: the
    /// report can be regenerated once someone fixes the column, but nobody ever notices an hour.
    /// So this throws, the report pass records a visible failure, and a person fixes it.
    /// </para>
    /// </summary>
    public static TimeZoneInfo Resolve(string? timeZoneId)
    {
        var id = (timeZoneId ?? string.Empty).Trim();

        if (id.Length == 0)
        {
            throw new ReportTimeZoneException(
                id,
                "the project has no time zone set, so there is no way to know what local time to "
                + $"print; expected an IANA id such as '{Default}'");
        }

        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(id);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            throw new ReportTimeZoneException(
                id,
                $"'{id}' is not a time zone this host can resolve; expected an IANA id such as "
                + $"'{Default}'",
                ex);
        }
    }
}

/// <summary>Refuses to print a timestamp rather than print the wrong one. Terminal: no retry
/// turns an unknown zone id into a known one.</summary>
public sealed class ReportTimeZoneException(
    string timeZoneId, string message, Exception? inner = null)
    : Exception(message, inner)
{
    public string TimeZoneId { get; } = timeZoneId;
}
