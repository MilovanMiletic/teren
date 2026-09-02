using System.Text.Json.Nodes;

namespace Teren.Api.Contracts;

/// <summary>
/// One line of the log, as the super admin's viewer reads it (D5).
///
/// <para>
/// <b>This DTO is the one place the privacy guard had to be narrowed, and the narrowing is the
/// plan's own.</b> <c>PlatformPrivacyTests</c> refuses any platform DTO property whose <em>name</em>
/// contains an evidence word, because that is how the boundary would really be lost — somebody
/// adds <c>entry_count</c> to a company row and every other test stays green. <c>entry_id</c>
/// trips that rule, and it is admitted anyway because the plan's <c>app_log</c> block settles it
/// in as many words: <em>"an ID is not evidence; it is how you find the row"</em>. The guard now
/// admits a property named exactly <c>EntryId</c> whose type really is a UUID — so
/// <c>EntryCount</c> (an <c>int</c>) and <c>EntryNotes</c> (a <c>string</c>) still fail.
/// </para>
///
/// <para>
/// <b><see cref="Id"/> is a string.</b> The column is <c>bigserial</c>, and a JSON number in a
/// browser loses precision above 2^53. Sending it as a number would work perfectly for years and
/// then quietly return the wrong row.
/// </para>
///
/// <para>
/// What this DTO still deliberately does not contain, on the same footing as the rest of
/// <c>PlatformContracts</c>: no addresses, no coordinates, no recipients, no transcript, no
/// structure, no note. Those cannot reach it, because the sink that fills the table drops any
/// property it was not told about by name.
/// </para>
/// </summary>
public sealed record PlatformLogResponse(
    string Id,
    DateTimeOffset At,
    /// <summary>`Verbose` | `Debug` | `Information` | `Warning` | `Error` | `Fatal`.</summary>
    string Level,
    /// <summary>The class that logged, or <c>web.&lt;area&gt;</c> for an event from the app.</summary>
    string Source,
    /// <summary>The unrendered template — the only stable thing to group a firehose by.</summary>
    string Template,
    string Message,
    /// <summary>
    /// The allow-listed structured properties, <b>inline JSON rather than a quoted string</b>.
    /// A client that had to <c>JSON.parse</c> a field of a JSON document would be one escape
    /// level away from every value in it, and the first bug that follows is a viewer printing
    /// <c>{\"Attempt\": 3}</c> at a person.
    /// </summary>
    JsonNode? Properties,
    /// <summary>Type chain, an allow-listed message and a truncated stack. Never a raw
    /// <c>ToString()</c>.</summary>
    string? Exception,
    Guid? CompanyId,
    Guid? EntryId,
    string? Correlation);

/// <summary>
/// A page of the stream, and the cursor that continues it.
/// <para>
/// <b>Keyset over <c>(at DESC, id DESC)</c>, never offset.</b> The reason is sharper here than on
/// the other platform lists: this table is a live firehose, so between two offset pages a dozen
/// rows arrive above the window and the reader sees the same lines twice while others slip past
/// unread. <c>NextCursor</c> is null when the page is the last one.
/// </para>
/// </summary>
public sealed record PlatformLogListResponse(
    IReadOnlyList<PlatformLogResponse> Logs,
    string? NextCursor);

/// <summary>
/// What the app reports about itself: one batch of things a person did (D5, contract §3).
///
/// <para>
/// <b>Validation on this type is a security boundary, not politeness.</b> Everything here comes
/// from a phone, and the whole point of the log viewer is that Teren staff can read it — so the
/// rule is <em>reject rather than sanitise</em>. An <c>action</c> is a slug and a slug cannot carry
/// a transcript; a <c>route</c> may carry an id but never a query string, because a query string is
/// where the words somebody typed end up.
/// </para>
/// <para>
/// The one thing that is <b>not</b> taken from this body is the company. It comes from the
/// caller's own credential, always — otherwise a phone could write log rows against another
/// customer's account, which is the cheapest possible way to make the log stream untrustworthy.
/// </para>
/// </summary>
public sealed record ClientEventBatchRequest
{
    public IReadOnlyList<ClientEventRequest>? Events { get; init; }
}

/// <summary>One thing that happened in the app.</summary>
public sealed record ClientEventRequest
{
    /// <summary>Generated on the phone; becomes <c>correlation</c>, which is how a replayed batch
    /// is recognisable afterwards.</summary>
    public Guid? Id { get; init; }

    public DateTimeOffset? At { get; init; }

    /// <summary>`area.thing.verb`, lower-case. See the contract's vocabulary.</summary>
    public string? Action { get; init; }

    /// <summary>The route the person was on. No query string and no fragment.</summary>
    public string? Route { get; init; }

    /// <summary>`ok` | `fail` | `cancel` | `blocked`, or absent.</summary>
    public string? Outcome { get; init; }

    public long? DurationMs { get; init; }

    public Guid? EntryId { get; init; }

    public Guid? ProjectId { get; init; }

    /// <summary>
    /// Up to ten extra facts. <b>A value may only be a number, a boolean or a slug</b> — anything
    /// else, including a string with a space in it, means the key is dropped and the event is
    /// kept. There is no path by which free text from a phone reaches the log table.
    /// </summary>
    public IReadOnlyDictionary<string, System.Text.Json.JsonElement>? Detail { get; init; }
}

/// <summary>
/// What became of a batch.
/// <para>
/// <b>Always 202, never a 4xx for a partly bad batch.</b> The phone is an offline-first client with
/// a queue: a rejection makes it retry the same batch for ever because one row in it was
/// malformed, which costs battery and never heals. The counts are the honest answer — the app can
/// notice a rising <c>rejected</c> and its author can fix the call site.
/// </para>
/// </summary>
public sealed record ClientEventBatchResponse(int Accepted, int Rejected);
