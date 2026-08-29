namespace Teren.Api.Contracts;

/// <summary>
/// A site the calling device may write entries for. Deliberately not the whole row: the
/// project's recipient list is client data the phone has no reason to carry around, and the
/// vocabulary is an input to the server-side pipeline, not to the UI.
/// </summary>
public sealed record ProjectResponse(
    Guid Id,
    string Name,
    string? Address,
    double? Latitude,
    double? Longitude,
    string ReportLanguage);
