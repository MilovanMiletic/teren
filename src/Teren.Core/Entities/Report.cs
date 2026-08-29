namespace Teren.Core.Entities;

public enum ReportKind
{
    Daily,
    Weekly,
}

/// <summary>A generated PDF report covering one or more entries of a project.</summary>
public sealed class Report
{
    public Guid Id { get; set; }
    public Guid CompanyId { get; set; }
    public Guid ProjectId { get; set; }
    public ReportKind Kind { get; set; }
    public DateOnly PeriodStart { get; set; }
    public DateOnly PeriodEnd { get; set; }
    public string? PdfObjectKey { get; set; }

    /// <summary>JSON: [{name, email, role}] — snapshot of who it was sent to.</summary>
    public string? Recipients { get; set; }

    public DateTime? SentAt { get; set; }
    public DateTime CreatedAt { get; set; }
}
