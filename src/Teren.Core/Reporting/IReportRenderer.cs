namespace Teren.Core.Reporting;

/// <summary>
/// Lays a resolved <see cref="DailyReport"/> out as a PDF. Behind an interface for the same
/// reason every other external dependency is: the layout engine is a licensing and rendering
/// decision (ARCHITECTURE §1), and the report pass should not know which one it got.
/// <para>
/// Synchronous on purpose — it is CPU and disk work with no network in it — and therefore only
/// ever called from a Hangfire job.
/// </para>
/// </summary>
public interface IReportRenderer
{
    /// <summary>The engine's name, for logs.</summary>
    string Name { get; }

    /// <summary>Produces the PDF bytes. Throws only if the document genuinely cannot be laid
    /// out; the caller turns that into a visible <see cref="ReportFailure.RenderFailed"/>.</summary>
    byte[] RenderDaily(DailyReport report);
}
