namespace Teren.Core.Entities;

/// <summary>A construction site the company keeps a diary for.</summary>
public sealed class Project
{
    public Guid Id { get; set; }
    public Guid CompanyId { get; set; }
    public string Name { get; set; } = null!;
    public string? Address { get; set; }

    /// <summary>Site coordinates (WGS84). Plain columns — no spatial queries needed.</summary>
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }

    /// <summary>JSON: [{name, email, role}] — who receives the reports.</summary>
    public string? Recipients { get; set; }

    /// <summary>JSON: work items, worker names, materials — STT/LLM recognition hints.</summary>
    public string? Vocabulary { get; set; }

    /// <summary>Report/email language for this client (not the foreman's device language).</summary>
    public string ReportLanguage { get; set; } = "sr";

    /// <summary>
    /// The site's own wall-clock zone, as an IANA id — the same per-project shape as
    /// <see cref="ReportLanguage"/>, and for the same reason: a report belongs to the place the
    /// work happened, not to the server or to the foreman's phone. Every timestamp on the report
    /// is rendered in it. Storage stays UTC everywhere (ARCHITECTURE §6).
    /// </summary>
    public string TimeZone { get; set; } = Reporting.ReportTimeZone.Default;

    public DateTime CreatedAt { get; set; }
}
