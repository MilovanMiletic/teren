namespace Teren.Core.Storage;

/// <summary>
/// The object-key layout (ARCHITECTURE §8). Ids only — never a name, an address, a project title
/// or anything else that identifies a person, because keys leak through logs, storage consoles
/// and support tickets.
/// </summary>
public static class ObjectKeys
{
    public static string ForMedia(
        Guid companyId, Guid projectId, Guid entryId, Guid mediaId, string extension) =>
        $"company/{companyId:D}/project/{projectId:D}/entry/{entryId:D}/{mediaId:D}.{extension}";

    /// <summary>
    /// Where an entry's daily report PDF lives. Derived from the entry rather than from the
    /// report row's id, so a report pass that failed after rendering and is run again overwrites
    /// its own output instead of stranding an orphan object nobody will ever fetch or bill for.
    /// <para>
    /// Same rule as media: ids only. The project name is a street address and the recipients are
    /// named people; neither goes anywhere near a key.
    /// </para>
    /// </summary>
    public static string ForEntryReport(Guid companyId, Guid projectId, Guid entryId) =>
        $"company/{companyId:D}/project/{projectId:D}/entry/{entryId:D}/report.pdf";
}
