namespace Teren.Core.Entities;

/// <summary>
/// The single definition of how each enum is spelled outside C#: in Postgres columns, in API
/// JSON, in logs. One mapping, so the wire vocabulary and the stored vocabulary can never drift
/// apart — a status read from psql is literally the status a client sees.
/// </summary>
public static class EntryStatusNames
{
    public const string Received = "received";
    public const string Processing = "processing";
    public const string AwaitingConfirmation = "awaiting_confirmation";
    public const string NeedsReview = "needs_review";
    public const string Confirmed = "confirmed";
    public const string Reported = "reported";

    public static string ToWire(EntryStatus status) => status switch
    {
        EntryStatus.Received => Received,
        EntryStatus.Processing => Processing,
        EntryStatus.AwaitingConfirmation => AwaitingConfirmation,
        EntryStatus.NeedsReview => NeedsReview,
        EntryStatus.Confirmed => Confirmed,
        EntryStatus.Reported => Reported,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null),
    };

    public static EntryStatus Parse(string value) => value switch
    {
        Received => EntryStatus.Received,
        Processing => EntryStatus.Processing,
        AwaitingConfirmation => EntryStatus.AwaitingConfirmation,
        NeedsReview => EntryStatus.NeedsReview,
        Confirmed => EntryStatus.Confirmed,
        Reported => EntryStatus.Reported,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}

public static class MediaKindNames
{
    public const string Audio = "audio";
    public const string Photo = "photo";

    public static string ToWire(MediaKind kind) => kind switch
    {
        MediaKind.Audio => Audio,
        MediaKind.Photo => Photo,
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };

    public static MediaKind Parse(string value) => value switch
    {
        Audio => MediaKind.Audio,
        Photo => MediaKind.Photo,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };

    /// <summary>Lenient parse for untrusted client input; false instead of an exception.</summary>
    public static bool TryParse(string? value, out MediaKind kind)
    {
        switch (value)
        {
            case Audio:
                kind = MediaKind.Audio;
                return true;
            case Photo:
                kind = MediaKind.Photo;
                return true;
            default:
                kind = default;
                return false;
        }
    }
}

public static class MediaUploadStatusNames
{
    public const string Pending = "pending";
    public const string Uploaded = "uploaded";
    public const string Verified = "verified";
    public const string Failed = "failed";

    public static string ToWire(MediaUploadStatus status) => status switch
    {
        MediaUploadStatus.Pending => Pending,
        MediaUploadStatus.Uploaded => Uploaded,
        MediaUploadStatus.Verified => Verified,
        MediaUploadStatus.Failed => Failed,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null),
    };

    public static MediaUploadStatus Parse(string value) => value switch
    {
        Pending => MediaUploadStatus.Pending,
        Uploaded => MediaUploadStatus.Uploaded,
        Verified => MediaUploadStatus.Verified,
        Failed => MediaUploadStatus.Failed,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}

public static class ReportKindNames
{
    public const string Daily = "daily";
    public const string Weekly = "weekly";

    public static string ToWire(ReportKind kind) => kind switch
    {
        ReportKind.Daily => Daily,
        ReportKind.Weekly => Weekly,
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };

    public static ReportKind Parse(string value) => value switch
    {
        Daily => ReportKind.Daily,
        Weekly => ReportKind.Weekly,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}

public static class ReportStatusNames
{
    public const string Sending = "sending";
    public const string Sent = "sent";
    public const string Failed = "failed";

    public static string ToWire(ReportStatus status) => status switch
    {
        ReportStatus.Sending => Sending,
        ReportStatus.Sent => Sent,
        ReportStatus.Failed => Failed,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null),
    };

    public static ReportStatus Parse(string value) => value switch
    {
        Sending => ReportStatus.Sending,
        Sent => ReportStatus.Sent,
        Failed => ReportStatus.Failed,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}
