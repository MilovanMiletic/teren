using System.ComponentModel.DataAnnotations;

namespace Teren.Infrastructure.Tenancy;

/// <summary>
/// Bound from the <c>Auth</c> configuration section.
/// <para>
/// M0 only. The dev token in appsettings.Development.json is a throwaway like the dev Postgres
/// password; staging and production set <c>Auth__DeviceToken</c> as an environment variable.
/// There is no default: an unconfigured token stops the application from starting rather than
/// silently opening the API.
/// </para>
/// </summary>
public sealed class DeviceAuthOptions
{
    public const string SectionName = "Auth";

    [Required(AllowEmptyStrings = false)]
    [MinLength(16, ErrorMessage = "Auth:DeviceToken must be at least 16 characters.")]
    public string DeviceToken { get; set; } = string.Empty;

    /// <summary>
    /// The tenant the static token acts for. Empty means the seeded demo company, which is what
    /// the distributor demo runs on.
    /// </summary>
    public Guid? CompanyId { get; set; }

    /// <summary>Provenance stamped on entries that do not declare their own device id.</summary>
    public Guid? DeviceId { get; set; }
}
