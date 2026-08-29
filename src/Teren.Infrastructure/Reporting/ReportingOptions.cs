using System.ComponentModel.DataAnnotations;
using Teren.Infrastructure.Processing;

namespace Teren.Infrastructure.Reporting;

/// <summary>How the mail relay is reached. Never plain <c>25</c> from the VPS — see
/// <see cref="ReportingOptions"/>.</summary>
public enum SmtpSecurity
{
    /// <summary>Let MailKit decide from the port and the server's greeting. Fine for a local
    /// catcher; name the mode explicitly for anything that carries a real report.</summary>
    Auto,

    /// <summary>No TLS at all. Only ever correct for a mail catcher on localhost.</summary>
    None,

    /// <summary>Plain connection upgraded with STARTTLS, and it must succeed (port 587).</summary>
    StartTls,

    /// <summary>Implicit TLS from the first byte (port 465).</summary>
    SslOnConnect,
}

public sealed class SmtpOptions
{
    /// <summary>
    /// The relay's hostname. **Empty means no relay is configured**, which makes report delivery
    /// fail visibly rather than stopping the host from booting — the same policy the AI keys get,
    /// because capture and upload need no relay at all.
    /// </summary>
    public string Host { get; set; } = string.Empty;

    [Range(1, 65535)]
    public int Port { get; set; } = 1025;

    public SmtpSecurity Security { get; set; } = SmtpSecurity.Auto;

    public string Username { get; set; } = string.Empty;

    /// <summary>Never committed. <c>Reporting__Smtp__Password</c> as an environment variable in
    /// staging and production; user-secrets on a developer machine.</summary>
    public string Password { get; set; } = string.Empty;

    /// <summary>
    /// Ceiling on one <b>protocol operation</b> — which is all MailKit's own timeout is. A minute
    /// rather than its default two.
    /// </summary>
    /// <remarks>
    /// This is deliberately <em>not</em> the number the stale-window arithmetic rests on. See
    /// <see cref="ConversationBudget"/>.
    /// </remarks>
    [Range(typeof(TimeSpan), "00:00:05", "00:05:00")]
    public TimeSpan Timeout { get; set; } = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Ceiling on the <b>whole relay conversation</b>, and the number
    /// <see cref="ReportingOptions.WorstCasePass"/> is computed from.
    /// <para>
    /// It exists because <see cref="Timeout"/> is per protocol operation, not per conversation:
    /// the greeting, AUTH, MAIL FROM, one RCPT TO per recipient, DATA and the content upload are
    /// each allowed <see cref="Timeout"/> on their own. One attempt can therefore stall several
    /// multiples of it, three attempts several more, and the arithmetic
    /// <c>ReportingContractTests</c> asserts would be a description rather than a bound — until a
    /// pass outran <see cref="ReportingOptions.StaleAfter"/> and landed in the one branch where
    /// the relay has the message and the row cannot record it. <c>SmtpReportDelivery</c> enforces
    /// this with a linked <see cref="CancellationTokenSource"/> around the whole conversation.
    /// </para>
    /// <para>
    /// Comfortably larger than <see cref="Timeout"/> on purpose. A 15 MB report on a slow uplink
    /// is a legitimately slow conversation, and cutting one short after transmission has begun is
    /// not free — it is custody-unknown, and it costs a person a decision.
    /// </para>
    /// </summary>
    [Range(typeof(TimeSpan), "00:00:10", "00:15:00")]
    public TimeSpan ConversationBudget { get; set; } = TimeSpan.FromMinutes(3);
}

/// <summary>
/// Everything B6 needs that is not a secret in code.
/// <para>
/// **Do not send directly from the VPS.** Hetzner blocks outbound port 25 by default and a fresh
/// VPS address has no sending reputation, so a report sent that way lands in the client's spam
/// folder — and the report *is* the product (ARCHITECTURE §10). Point <see cref="Smtp"/> at an
/// authenticated relay, and put SPF, DKIM and DMARC records on the sending domain. Locally,
/// <c>docker compose</c> runs Mailpit on <c>localhost:1025</c> so the whole path is provable
/// without any of that.
/// </para>
/// </summary>
public sealed class ReportingOptions
{
    public const string SectionName = "Reporting";

    /// <summary>
    /// The envelope sender. Must be on a domain whose SPF/DKIM/DMARC records name the relay, or
    /// the message is authenticated as nobody and filtered as spam. Empty means unconfigured.
    /// </summary>
    public string FromAddress { get; set; } = string.Empty;

    /// <summary>The display name a client sees. Defaults to the contractor's own company name
    /// when left empty, which is what the client expects to see in his inbox.</summary>
    public string FromName { get; set; } = string.Empty;

    /// <summary>Where a client's reply should go. Empty means no Reply-To header, and the mail
    /// body then says not to reply.</summary>
    public string ReplyToAddress { get; set; } = string.Empty;

    public SmtpOptions Smtp { get; set; } = new();

    /// <summary>
    /// One budget for the whole of gathering the evidence, verifying every photo's checksum,
    /// laying the PDF out and storing it — everything that happens **before** the claim row
    /// exists and therefore before anything irreversible.
    /// <para>
    /// It exists for the same reason <c>Storage:VerificationBudget</c> does: an entry may carry
    /// twenty photos, and a storage host that answers slowly rather than not at all would
    /// otherwise multiply the per-object timeout by twenty and let one pass outlive
    /// <see cref="StaleAfter"/>. Running out is safe — nothing was sent — so the entry stays
    /// <c>confirmed</c> with a visible reason and can be reported again.
    /// </para>
    /// </summary>
    /// <remarks>The two-second floor is not a sane production value; it exists so the suite can
    /// prove the timeout path in two seconds rather than five minutes, exactly as
    /// <c>Storage:VerificationBudget</c> does.</remarks>
    [Range(typeof(TimeSpan), "00:00:02", "00:30:00")]
    public TimeSpan RenderBudget { get; set; } = TimeSpan.FromMinutes(5);

    /// <summary>
    /// How long a report may sit in <c>sending</c> before the sweeper decides nobody is working
    /// on it. Same role as <c>Pipeline:StaleProcessingAfter</c>, and the same obligation: it must
    /// exceed the worst-case wall-clock of one report pass, which
    /// <c>ReportingOptionsTests</c> recomputes rather than trusts.
    /// <para>
    /// Worst case at the shipped defaults:
    /// </para>
    /// <list type="bullet">
    /// <item>gather + verify + render + store: capped at <see cref="RenderBudget"/>, 5 min</item>
    /// <item>delivery: <c>Reporting:Smtp:ConversationBudget</c> 3 min x <c>Pipeline:MaxAttempts</c>
    /// 3 = 9 min</item>
    /// <item>backoff between delivery attempts: 2 s + 4 s</item>
    /// </list>
    /// <para>
    /// ~14.1 minutes. 30 leaves over twice the headroom and is still short enough that a report
    /// abandoned by a deploy is visible within a working session.
    /// </para>
    /// </summary>
    [Range(typeof(TimeSpan), "00:05:00", "02:00:00")]
    public TimeSpan StaleAfter { get; set; } = TimeSpan.FromMinutes(30);

    /// <summary>
    /// Resolution photographs are re-encoded to inside the PDF. 144 rather than QuestPDF's
    /// default 288: the phone already compresses to 1600 px / JPEG ~80 (~300 KB), and twenty of
    /// those at print DPI make an attachment many relays refuse. At 144 a full twenty-photo
    /// report lands around 2–3 MB and every photo is still legible at full page width.
    /// </summary>
    [Range(72, 600)]
    public int PhotoRasterDpi { get; set; } = 144;

    /// <summary>
    /// The size above which an attachment is worth a loud log line. Not a refusal: a report that
    /// exists must go out, and a relay bouncing it produces a visible
    /// <c>delivery_rejected</c> anyway. This is the early warning before that happens.
    /// </summary>
    [Range(1L * 1024 * 1024, 100L * 1024 * 1024)]
    public long AttachmentSizeWarningBytes { get; set; } = 15L * 1024 * 1024;

    /// <summary>
    /// The product's mark in the report masthead, set as letterspaced type. Configuration rather
    /// than a constant so a rename never needs a code change — and so this and
    /// <see cref="BrandLogoPath"/> read as the one brand knob they are.
    /// </summary>
    [Required]
    [MaxLength(32)]
    public string BrandWordmark { get; set; } = "TEREN";

    /// <summary>
    /// **The one config line that swaps the wordmark for a real logo.** An absolute path to an
    /// image file; when set and readable, it is drawn in the masthead's brand slot at exactly the
    /// slot's height, so nothing else on the page moves. Empty — the default, and the state of
    /// the repo, which carries no image asset — draws <see cref="BrandWordmark"/> instead.
    /// <para>
    /// A path that does not exist is a warning at start-up and the wordmark, never a failed
    /// report: the mark is the only thing on this page that carries no evidence.
    /// </para>
    /// </summary>
    public string BrandLogoPath { get; set; } = string.Empty;

    /// <summary>Whether a relay is configured at all.</summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Smtp.Host) && !string.IsNullOrWhiteSpace(FromAddress);

    /// <summary>
    /// The worst-case wall-clock of one report pass, derived rather than asserted, so
    /// <see cref="StaleAfter"/> can be checked against it by a test instead of by a comment.
    /// </summary>
    public TimeSpan WorstCasePass(PipelineOptions pipeline)
    {
        // ConversationBudget, not Timeout: the per-operation timeout bounds one command, the
        // conversation budget bounds one attempt, and it is attempts that are multiplied here.
        var delivery = Smtp.ConversationBudget * pipeline.MaxAttempts;

        var backoff = TimeSpan.Zero;
        var delay = pipeline.RetryDelay;
        for (var attempt = 1; attempt < pipeline.MaxAttempts; attempt++)
        {
            backoff += delay;
            delay += delay;
        }

        return RenderBudget + delivery + backoff;
    }
}
