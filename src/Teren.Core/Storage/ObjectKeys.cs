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
}
