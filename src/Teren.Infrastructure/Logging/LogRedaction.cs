using System.Text;
using System.Text.RegularExpressions;

namespace Teren.Infrastructure.Logging;

/// <summary>
/// The named property allow-list, enforcement 1 of the three that make the log viewer safe to
/// ship (plan §12).
///
/// <para>
/// <b>An unknown property is dropped, not stored.</b> The audit behind this increment found the
/// existing ~104 log call sites already clean — ids, counts, durations, provider names, status
/// codes, outcomes, and never a transcript or an address. That is a <em>habit</em>, and a habit
/// is exactly the wrong thing to rest a security boundary on once a screen shows the result to
/// Teren staff. With this list, new logging that wants a new property has to add it here on
/// purpose, in a diff a reviewer sees.
/// </para>
///
/// <para>
/// <b>Note what is deliberately absent.</b> There is no <c>From</c> (the relay's own sender
/// address on the start-up line — an address, on a console line the founder reads on the console),
/// no <c>Email</c>, no <c>Transcript</c>, no <c>Structure</c>, no <c>Notes</c>, no
/// <c>Recipients</c> holding anything but a count. Nothing on this list is a fact about what
/// happened on a customer's site; everything on it is a fact about the machine.
/// </para>
///
/// <para>
/// Dropping a property does not silence the line — the message keeps the placeholder, unrendered,
/// so a reader sees an omission rather than a fact — and the console sink is untouched, so nothing
/// is lost to the operator standing at the process.
/// </para>
/// </summary>
public static class LogProperties
{
    /// <summary>
    /// Properties that are lifted into their own <c>app_log</c> column instead of the JSON bag.
    /// They are allowed by construction: a column exists precisely so the viewer can filter on
    /// them.
    /// </summary>
    public const string SourceContext = "SourceContext";

    public const string EntryId = "EntryId";
    public const string CompanyId = "CompanyId";
    public const string Correlation = "Correlation";

    private static readonly HashSet<string> Columns =
        new(StringComparer.Ordinal) { SourceContext, EntryId, CompanyId, Correlation };

    /// <summary>
    /// Everything else that may be stored, by name. Ordered as the plan describes the rule —
    /// ids, counts, durations, provider names, status codes, outcomes — so that adding a name
    /// forces the question "which of these is it?".
    /// </summary>
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
    {
        // Identifiers. An id is not evidence; it is how you find the row.
        "ActorUserId", "DeviceId", "MediaId", "ProjectId", "ReportId", "SubjectId", "UserId",

        // Counts and sizes.
        "Attempt", "Bytes", "Count", "DeclaredBytes", "Deleted", "Enqueued", "FailedCount",
        "InputTokens", "Kilobytes", "Length", "MaxAttempts", "MaxFilesPerRequest", "MediaCount",
        "Megabytes", "OutputTokens", "Parked", "PendingCount", "Photos", "RecipientCount",
        "Recipients", "ReportsFailed", "ReportsQueued", "Requested", "ServerCount", "Skipped",
        "StoredBytes", "SupersededCount", "Total",

        // Durations, schedules and clock stamps.
        "DelayMs", "ElapsedMs", "ExpiresAt", "LockTimeout", "MaxAgeSeconds", "ReportedAt",
        "SentAt", "StaleMinutes", "SweepCron", "TimeZoneId", "Timestamp",

        // Providers, transports and the machine's own configuration. `BrandLogoPath` is the one
        // filesystem path on this list and it is named after its one setting on purpose: a general
        // `Path` was how the caller's own URL reached this table (see below).
        // `DbContextName` and `Pending` belong to the readiness checks and are named as narrowly
        // as `BrandLogoPath` is, for the same reason: `DbContextName` can only ever be one of two
        // `nameof` values, and `Pending` is a list of EF migration ids off the shipped assembly.
        // Neither can be written from outside the process. A general `Context` was the first
        // draft, and a name that general is the `Path` mistake with a new label.
        "AppLabel", "BrandLogoPath", "Bucket", "CacheRead", "CodeLabel", "DbContextName",
        "Default", "DevelopmentEnvironment", "EnabledSetting", "Host", "Locale", "Model",
        "Pending", "Port", "Provider", "Realm", "Security", "Transport", "UsernameLabel",
        "VersionKey", "Wordmark", "Workspace",

        // Outcomes, states and codes — the vocabulary the pipeline branches on.
        "CommandName", "ConfirmFlag", "DeleteGuardTrigger", "EntryDate", "FailureCode", "Language",
        "Level", "Missing", "Operation", "Outcome", "Ready", "Reason", "ResetPasswordFlag", "Role",
        "Status", "StructureState",

        // The request line, and the relay's own words. Never a body, never a query string —
        // and, since the D5 review, never a URL either.
        //
        // `Path` and `Message` used to be here, and between them they were the one hole in this
        // whole arrangement. `Path` was `http.Request.Path` on the 401 challenge, the 403 refusal
        // and the storage handler; `Message` was `BadHttpRequestException.Message`, which echoes
        // the value it could not parse. Both run for callers who have proved nothing — the 401
        // path by definition, parameter binding even earlier — so any matched route with a free
        // segment was an anonymous write of up to MaxText characters into the table Teren staff
        // read. `Route` replaced them: the matched route template, which comes from the route
        // table and cannot be anything a caller typed.
        "Method", "ObjectKey", "Response",

        // The phone's own events (POST /api/client-events) share `Route`. Their values are
        // validated at the edge — a slug, a number or a boolean and nothing else — which is what
        // makes them safe without being namable in advance.
        "Route", "Action", "DurationMs", "Detail",
    };

    /// <summary>True when this property may be stored in the JSON bag.</summary>
    public static bool IsAllowed(string name) => Allowed.Contains(name);

    /// <summary>True when this property has a column of its own and must not be duplicated into
    /// the bag.</summary>
    public static bool IsColumn(string name) => Columns.Contains(name);

    /// <summary>Exposed for the test that proves this list is a list and not an empty set.</summary>
    public static IReadOnlyCollection<string> AllowedNames => Allowed;
}

/// <summary>
/// Enforcement 2: what is done to free text before it is stored.
///
/// <para>
/// <b>The exception message is the real risk, and the plan names it exactly</b>:
/// <c>BoundedRetry</c> logs <c>LogWarning(ex, …)</c>, and a third-party exception from Anthropic
/// or Azure can echo the request back in its own message. So exception <em>messages</em> are
/// allow-listed by exception <b>type</b>, and the list is short.
/// </para>
///
/// <para>
/// <b><c>AiProviderException</c> is deliberately not on it, even though it is ours.</b> That is the
/// trap worth stating: "our type, therefore safe" is false here, because
/// <c>ClaudeStructureExtractor</c> builds its message as
/// <c>$"the model API rejected the request: {ex.Message}"</c> and
/// <c>AzureFastTranscriptionProvider</c> folds a summary of the response <em>body</em> into
/// its own. An allow-list by assembly would have admitted precisely the message this enforcement
/// exists to keep out. The type and the stack are always kept, so a withheld message never costs
/// the operator the ability to see <em>what</em> failed and <em>where</em>.
/// </para>
///
/// <para>
/// On top of that, everything stored — messages, property values, exception text — goes through
/// one address scrub. A relay's own answer (<c>250 2.1.5 Ok &lt;…&gt;</c>) is the one place an
/// address can arrive from a source nobody here wrote, and ARCHITECTURE §12 keeps personal data
/// out of logs regardless of who put it there.
/// </para>
/// </summary>
public static partial class LogScrubbing
{
    /// <summary>How much of an allow-listed exception message survives. Long enough for
    /// "Connection refused", short enough that nothing prose-shaped gets through.</summary>
    public const int MaxExceptionMessage = 300;

    /// <summary>How much stack is kept. Deep enough to reach out of the framework and into our own
    /// frames, bounded so one pathological exception cannot become the largest row in the
    /// table.</summary>
    public const int MaxStackTrace = 4_000;

    /// <summary>The cap on a rendered message and on any single stored string value.</summary>
    public const int MaxText = 2_000;

    /// <summary>What stands in for a message the allow-list refused.</summary>
    public const string WithheldMessage =
        "(message withheld: this exception type can echo request content)";

    public const string RedactedAddress = "<address redacted>";

    /// <summary>
    /// Exception types whose <c>Message</c> may be stored. Matched on the <b>exact</b> type, never
    /// on assignability: <c>AiProviderNotConfiguredException</c> is safe (its message is built from
    /// a provider name and a setting name) and its base class is not, and an <c>is</c> check would
    /// admit the base through the derived one.
    /// </summary>
    private static readonly HashSet<string> MessageSafeTypes = new(StringComparer.Ordinal)
    {
        "System.TimeoutException",
        "System.OperationCanceledException",
        "System.Threading.Tasks.TaskCanceledException",
        "System.Net.Sockets.SocketException",
        "System.ObjectDisposedException",
        "Teren.Core.Ai.AiProviderNotConfiguredException",
        "Teren.Core.Storage.ObjectStorageUnavailableException",
    };

    /// <summary>
    /// The stored form of an exception: the type chain, an allow-listed message per link, and one
    /// truncated stack. Never <c>ex.ToString()</c>, which is the whole message of every inner
    /// exception concatenated.
    /// </summary>
    public static string? Describe(Exception? exception)
    {
        if (exception is null)
        {
            return null;
        }

        var text = new StringBuilder();

        // Three links deep. Beyond that the chain is framework plumbing and the stack says more.
        var current = exception;
        for (var depth = 0; current is not null && depth < 3; depth++, current = current.InnerException)
        {
            if (depth > 0)
            {
                text.Append("\n ---> ");
            }

            var type = current.GetType();
            text.Append(type.FullName ?? type.Name).Append(": ").Append(MessageOf(current));
        }

        var stack = exception.StackTrace;
        if (!string.IsNullOrWhiteSpace(stack))
        {
            text.Append('\n').Append(Truncate(Addresses(stack), MaxStackTrace));
        }

        return text.ToString();
    }

    /// <summary>A stored string value: addresses removed, length capped.</summary>
    public static string Text(string? value) => Truncate(Addresses(value ?? string.Empty), MaxText);

    /// <summary>
    /// A line whose words were composed by somebody else's library — Hangfire, the framework, any
    /// component that formats its message before Serilog ever sees it.
    ///
    /// <para>
    /// Treated exactly as an allow-listed exception message is, and for the same reason: it is
    /// free text from a third party, so it is worth keeping (it is what "what is failing" is made
    /// of) and it must be short enough that nothing prose-shaped can ride in on it, with any
    /// address removed. <see cref="MaxExceptionMessage"/> and not <see cref="MaxText"/> — a
    /// framework line that needs two thousand characters is a stack trace wearing a message.
    /// </para>
    /// </summary>
    public static string ThirdPartyText(string? value) =>
        Truncate(Addresses(value ?? string.Empty), MaxExceptionMessage);

    private static string MessageOf(Exception exception)
    {
        var name = exception.GetType().FullName ?? exception.GetType().Name;

        return MessageSafeTypes.Contains(name)
            ? Truncate(Addresses(exception.Message), MaxExceptionMessage)
            : WithheldMessage;
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : string.Concat(value.AsSpan(0, max), "… (truncated)");

    /// <summary>
    /// The one thing that can arrive from outside our own call sites: an email address inside a
    /// relay's answer or a framework message. Cheap, and it is the last line rather than the first
    /// — the allow-lists above are what actually hold.
    /// </summary>
    private static string Addresses(string value) =>
        value.Contains('@', StringComparison.Ordinal)
            ? EmailPattern().Replace(value, RedactedAddress)
            : value;

    [GeneratedRegex(
        @"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}",
        RegexOptions.CultureInvariant)]
    private static partial Regex EmailPattern();
}
