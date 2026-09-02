using System.Globalization;
using System.Text;
using Teren.Core.Reporting;

namespace Teren.Core.Identity;

/// <summary>
/// The words that go to a person rather than to a client: the message an admin pastes into one
/// worker's chat, and (from D6) the invite email.
/// <para>
/// <b>Structurally like <see cref="ReportStrings"/> but deliberately not part of it.</b>
/// <c>ReportStrings</c> is documented as the <em>report's</em> chrome, and the two speak different
/// languages by design — and the asymmetry is worth stating once, plainly:
/// </para>
/// <blockquote>
/// A report speaks the <b>project's</b> language, because the client reads it. An invite speaks
/// the <b>recipient's</b> (<c>app_user.language</c>), because he does.
/// </blockquote>
/// <para>
/// <b>There is deliberately no bulk export.</b> This builds a message for exactly one worker
/// (§2 decision 13). A group chat carrying six codes lets any worker activate a phone under
/// another man's name — and every entry he then records is signed with that name. Attribution is
/// the thing the whole identity model exists to establish; a bulk export would quietly undo it.
/// </para>
/// <para>
/// The Serbian copy here is written by Claude and still owes the founder's native review, exactly
/// as <c>ReportStrings</c> does.
/// </para>
/// </summary>
public sealed record InviteStrings
{
    /// <summary>What an unrecognised <c>app_user.language</c> falls back to.</summary>
    public const string DefaultLanguage = ReportStrings.DefaultLanguage;

    /// <summary>The same unambiguous, machine-independent date the report uses.</summary>
    private const string DatePattern = "dd.MM.yyyy.";

    public required string Language { get; init; }

    /// <summary>
    /// The subject line when this message is emailed rather than pasted into a chat (D6's worker
    /// half). It says what the mail contains and names no code — a subject line is the one part of
    /// an email that shows on a locked screen and gets quoted in a reply.
    /// </summary>
    public required string MailSubject { get; init; }

    /// <summary>"Zdravo {0}," — the worker's display name, with his diacritics intact.</summary>
    public required string Greeting { get; init; }

    public required string Instructions { get; init; }
    public required string UsernameLabel { get; init; }
    public required string CodeLabel { get; init; }
    public required string AppLabel { get; init; }

    /// <summary>"Kod važi do {0} i može da se iskoristi samo jednom." — the two facts a
    /// single-use credential must state, or somebody keeps the message and tries it next month.</summary>
    public required string Validity { get; init; }

    public static InviteStrings For(string? language) =>
        (language ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "en" or "en-us" or "en-gb" => English,
            _ => Serbian,
        };

    /// <summary>
    /// The message itself, ready to paste. Plain text with no markup: it is going into Viber or
    /// WhatsApp, where anything else arrives as literal asterisks.
    /// </summary>
    /// <param name="displayName">The worker's name, as he is called.</param>
    /// <param name="username">His durable identity — the first of the two things he types.</param>
    /// <param name="code">The code in its display form, <c>XKD4-7HMP</c>.</param>
    /// <param name="expiresAt">UTC, as stored; printed as a local date in <paramref name="zone"/>.</param>
    /// <param name="zone">The reader's zone. Required rather than defaulted for the same reason
    /// <see cref="ReportStrings.FormatTimestamp"/> requires one: an expiry printed a day early or
    /// late is a support call.</param>
    /// <param name="appUrl">Where to get the app, when the host knows. Omitted when it does not —
    /// a line saying "download it from (blank)" is worse than no line.</param>
    public string WorkerActivationMessage(
        string displayName,
        string username,
        string code,
        DateTime expiresAt,
        TimeZoneInfo zone,
        string? appUrl)
    {
        ArgumentNullException.ThrowIfNull(zone);

        var localExpiry = TimeZoneInfo.ConvertTime(
            new DateTimeOffset(DateTime.SpecifyKind(expiresAt, DateTimeKind.Utc)), zone);

        var message = new StringBuilder();
        message.AppendLine(string.Format(CultureInfo.InvariantCulture, Greeting, displayName));
        message.AppendLine(Instructions);
        message.AppendLine();
        message.AppendLine($"{UsernameLabel}: {username}");
        message.AppendLine($"{CodeLabel}: {code}");

        if (!string.IsNullOrWhiteSpace(appUrl))
        {
            message.AppendLine($"{AppLabel}: {appUrl.Trim()}");
        }

        message.AppendLine();
        message.Append(string.Format(
            CultureInfo.InvariantCulture,
            Validity,
            localExpiry.ToString(DatePattern, CultureInfo.InvariantCulture)));

        return message.ToString();
    }

    public static InviteStrings Serbian { get; } = new()
    {
        Language = "sr",
        MailSubject = "Kod za aktivaciju Teren aplikacije",
        Greeting = "Zdravo {0},",
        Instructions =
            "otvori Teren aplikaciju na telefonu i unesi ova dva podatka da aktiviraš telefon:",
        UsernameLabel = "Korisničko ime",
        CodeLabel = "Kod",
        AppLabel = "Aplikacija",
        Validity = "Kod važi do {0} i može da se iskoristi samo jednom.",
    };

    public static InviteStrings English { get; } = new()
    {
        Language = "en",
        MailSubject = "Your Teren activation code",
        Greeting = "Hello {0},",
        Instructions =
            "open the Teren app on your phone and enter these two details to activate it:",
        UsernameLabel = "Username",
        CodeLabel = "Code",
        AppLabel = "App",
        Validity = "The code is valid until {0} and can be used only once.",
    };
}
