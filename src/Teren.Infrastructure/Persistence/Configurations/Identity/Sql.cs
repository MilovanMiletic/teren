namespace Teren.Infrastructure.Persistence.Configurations.Identity;

/// <summary>
/// Builds the literal lists inside CHECK constraints out of the same constants the C# code uses,
/// so a renamed enum value can never leave a constraint policing a vocabulary that no longer
/// exists. The inputs are compile-time constants from <c>Teren.Core.Entities</c>, never user data.
/// </summary>
internal static class Sql
{
    public static string Quoted(IEnumerable<string> values) =>
        string.Join(",", values.Select(v => $"'{v}'"));
}
