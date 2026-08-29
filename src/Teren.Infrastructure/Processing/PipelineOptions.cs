using System.ComponentModel.DataAnnotations;
using Hangfire;

namespace Teren.Infrastructure.Processing;

/// <summary>
/// How hard the processing pipeline tries before it hands an entry to a human.
/// <para>
/// The shape of this section is the state machine's honesty policy in numbers: bounded attempts,
/// then <c>needs_review</c> with the raw evidence intact. Never an unbounded retry loop, never a
/// dropped entry (ROADMAP B4).
/// </para>
/// </summary>
public sealed class PipelineOptions
{
    public const string SectionName = "Pipeline";

    /// <summary>
    /// Attempts per external call, counting the first. Three because the failures worth retrying
    /// are transient by definition — a 429, a 5xx, a blip in storage — and a fourth attempt has
    /// never rescued a call the third did not.
    /// </summary>
    [Range(1, 10)]
    public int MaxAttempts { get; set; } = 3;

    /// <summary>Delay before the second attempt; doubled for each attempt after it.</summary>
    [Range(typeof(TimeSpan), "00:00:00", "00:05:00")]
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>
    /// How long an entry may sit in <c>processing</c> before the sweeper decides nobody is
    /// working on it. The realistic cause is a process restart mid-job — a deploy, a crash — and
    /// the entry must not stay invisible because of it.
    /// <para>
    /// **This number must exceed the worst-case wall-clock of one pass, and the arithmetic is
    /// checked here rather than asserted.** A brownout at Azure or Anthropic that stretched a
    /// healthy pass past this threshold would have the sweeper park a live entry, after which
    /// the worker's own terminal write is refused — the pass is wasted and the foreman is told
    /// to review something that was going to work. (It is no longer *corruption*: those writes
    /// are conditional on still owning the claim. It is still a bad afternoon.)
    /// </para>
    /// <para>
    /// Worst case at the shipped defaults, with the two providers' own retry loops turned off so
    /// only <see cref="MaxAttempts"/> multiplies anything:
    /// </para>
    /// <list type="bullet">
    /// <item>download: <c>Storage:DownloadTimeout</c> 2 min x 3 attempts = 6 min
    /// (<c>Storage:DownloadRetries</c> is 0 — the AWS SDK does not retry underneath us)</item>
    /// <item>transcription: <c>Stt:Azure:RequestTimeout</c> 2 min x 3 = 6 min</item>
    /// <item>extraction: <c>Anthropic:RequestTimeout</c> 3 min x 3 = 9 min
    /// (<c>AnthropicClient.MaxRetries</c> is 0 for the same reason)</item>
    /// <item>backoff between attempts: (2 s + 4 s) x 3 operations = 18 s</item>
    /// </list>
    /// <para>
    /// That is ~21.5 minutes. 45 gives roughly a factor of two of headroom and is still short
    /// enough that an entry abandoned by a deploy is visible inside a working session. Change
    /// any of the four timeouts above and this number has to be re-derived.
    /// </para>
    /// </summary>
    [Range(typeof(TimeSpan), "00:01:00", "02:00:00")]
    public TimeSpan StaleProcessingAfter { get; set; } = TimeSpan.FromMinutes(45);

    /// <summary>
    /// How often the sweeper looks for work the enqueue path missed. Whole minutes: it is
    /// scheduled as a cron expression (see <see cref="SweepCronExpression"/>), so anything finer
    /// cannot be expressed and anything in between is rounded.
    /// </summary>
    [Range(typeof(TimeSpan), "00:01:00", "01:00:00")]
    public TimeSpan SweepInterval { get; set; } = TimeSpan.FromMinutes(1);

    /// <summary>Entries enqueued per sweep, so a backlog drains in bounded steps.</summary>
    [Range(1, 500)]
    public int SweepBatchSize { get; set; } = 50;

    /// <summary>
    /// Recognition locale handed to the transcription provider (ARCHITECTURE §9.1). The **only**
    /// locale knob: <c>Stt:Azure:Locale</c> used to exist beside it and was never read, which is
    /// worse than no knob at all.
    /// <para>
    /// <c>sr-RS</c> is first-class on Azure AI Speech, and that — not phrase lists, which A3
    /// proved inert for Serbian — is why Azure was chosen (<c>docs/stt-evaluation.md</c>).
    /// </para>
    /// </summary>
    [Required(AllowEmptyStrings = false)]
    public string TranscriptionLocale { get; set; } = "sr-RS";

    /// <summary>
    /// <see cref="SweepInterval"/> as the cron expression Hangfire is actually given.
    /// <para>
    /// It exists so the option cannot become decorative: the recurring job is registered with
    /// this string and the start-up line logs this string, so there is no second place for the
    /// two to disagree. Cron's finest useful granularity here is a minute, so the interval is
    /// rounded to whole minutes and clamped to the hour; an interval that does not divide 60
    /// (7 minutes, say) is still valid cron but its last gap of the hour is shorter, which for a
    /// safety net is harmless.
    /// </para>
    /// </summary>
    public string SweepCronExpression()
    {
        var minutes = Math.Clamp(
            (int)Math.Round(SweepInterval.TotalMinutes, MidpointRounding.AwayFromZero), 1, 60);

        // Hangfire's own helpers rather than a hand-rolled string, so the expression cannot be
        // one this scheduler will not parse.
        return minutes >= 60 ? Cron.Hourly() : Cron.MinuteInterval(minutes);
    }
}
