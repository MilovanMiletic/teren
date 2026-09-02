using System.ComponentModel.DataAnnotations;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// Everything the database log sink is allowed to be tuned by, bound from <c>Logging</c>.
///
/// <para>
/// <b>Retention is a decision, not a default</b> (plan §12). <c>app_log</c> is a firehose and this
/// product runs on a small VPS: with nothing deleting rows, the log becomes the largest thing in
/// the database and the nightly backup grows without bound until a restore is the slowest thing in
/// the recovery. Fourteen days is long enough to answer "what happened last week" and short enough
/// that the table stays a rounding error beside the evidence.
/// </para>
///
/// <para>
/// The queue numbers are the other half of the same thought: <b>a log call must never block on the
/// database and must never throw into a request</b>, so the sink can only ever hand a row to a
/// bounded queue. Bounded, because an unbounded one turns a database outage into an out-of-memory
/// kill of the process that was still serving foremen perfectly well.
/// </para>
/// </summary>
public sealed class LoggingOptions
{
    /// <summary>
    /// <b>Shared with <c>Microsoft.Extensions.Logging</c>, deliberately and carefully.</b> MEL owns
    /// <c>Logging:LogLevel</c> and, for every other child of this section, reads only a nested
    /// <c>LogLevel</c> — so <c>Logging:RetentionDays</c> and its siblings are invisible to it, and
    /// <c>Logging:LogLevel</c> is invisible to this binder. The two coexist because neither name
    /// appears in the other's vocabulary, which is a fact about the current key set rather than a
    /// guarantee: <b>a new property here must not be a MEL provider alias</b> (<c>Console</c>,
    /// <c>Debug</c>, <c>EventSource</c>, <c>EventLog</c>, <c>ApplicationInsights</c>) and must not
    /// be called <c>LogLevel</c>. <c>LoggingOptionsTests</c> pins the coexistence.
    /// </summary>
    public const string SectionName = "Logging";

    /// <summary>How long a log line is kept before the nightly job deletes it.</summary>
    [Range(1, 365)]
    public int RetentionDays { get; set; } = 14;

    /// <summary>
    /// Turns the database sink off entirely. Console logging is unaffected — this is a switch for
    /// a host that has no <c>app_log</c> table yet (a migration has not run), not a way to stop
    /// logging.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// How many rows the queue holds before it starts dropping the oldest.
    /// <para>
    /// <b>Drop-oldest, not drop-newest.</b> When the writer is stuck, the interesting lines are
    /// the ones being written right now — the ones about whatever is going wrong — and the
    /// stale ones at the front are the least useful bytes in the process.
    /// </para>
    /// </summary>
    [Range(100, 200_000)]
    public int QueueCapacity { get; set; } = 10_000;

    /// <summary>Rows per INSERT round trip. One statement per line would put a network round trip
    /// on every log call, which is the cost this whole arrangement exists to avoid.</summary>
    [Range(1, 1_000)]
    public int BatchSize { get; set; } = 250;

    /// <summary>
    /// How often the background flusher drains the queue. Two seconds is short enough that the log
    /// viewer feels live and long enough that a busy minute is a few dozen round trips rather than
    /// a few thousand.
    ///
    /// <para>
    /// <b>Range-checked because zero stops the host.</b> <see cref="PeriodicTimer"/> throws on a
    /// non-positive period, and it is constructed on a <see cref="Microsoft.Extensions.Hosting
    /// .BackgroundService"/>, where an unhandled exception takes the process down by default —
    /// so <c>Logging__FlushInterval=00:00:00</c> would turn a typo in a deploy's environment into
    /// an API that will not boot. With <c>ValidateOnStart</c> it is a named configuration error at
    /// start-up instead. The ceiling is an hour because the suite sets exactly that to park the
    /// timer and flush by hand.
    /// </para>
    /// </summary>
    [Range(typeof(TimeSpan), "00:00:00.100", "01:00:00")]
    public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(2);

    public ClientEventOptions ClientEvents { get; set; } = new();
}

/// <summary>
/// The phone's half of the log stream.
/// </summary>
public sealed class ClientEventOptions
{
    /// <summary>
    /// The kill switch. <b>Turning it off answers <c>202 {accepted: 0}</c> rather than an
    /// error</b>, deliberately: a 4xx or a 5xx would make an offline-first client retry the same
    /// batch for ever, and a phone burning battery on a log upload nobody wants is a worse
    /// outcome than no telemetry at all.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Events per batch. A phone with a week of queued events sends several batches
    /// rather than one enormous one.</summary>
    [Range(1, 1_000)]
    public int MaxEventsPerBatch { get; set; } = 100;

    /// <summary>The largest body accepted, in bytes. The events are slugs, ids and numbers; a
    /// batch this size is already ten times anything the app produces, and the cap is what stops
    /// the route being a way to push megabytes into the log table.</summary>
    [Range(1_024, 1_048_576)]
    public int MaxBodyBytes { get; set; } = 64 * 1024;
}
