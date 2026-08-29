namespace Teren.Core.Entities;

/// <summary>
/// Server-side entry lifecycle. The phone has its own, deliberately different vocabulary
/// (draft/queued/uploading/confirmed_by_server) — do not merge the two.
/// </summary>
public enum EntryStatus
{
    Received,
    Processing,
    AwaitingConfirmation,
    NeedsReview,
    Confirmed,
    Reported,
}
