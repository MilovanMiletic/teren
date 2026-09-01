using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MimeKit;
using MimeKit.Text;
using Teren.Core.Mail;
using Teren.Infrastructure.Reporting;

namespace Teren.Infrastructure.Mail;

/// <summary>
/// Ordinary transactional mail over SMTP, on the same relay the reports use.
///
/// <para>
/// <b>Why this does not share code with <c>SmtpReportDelivery</c>, which was the plan's first
/// instinct.</b> The plan (§9) proposed splitting that class so the report path became a thin
/// adapter over a shared sender. What survives the reading of the code is that almost nothing is
/// actually shared: everything in <c>SmtpReportDelivery</c> that is longer than four lines exists
/// to answer <i>who holds the message</i> — the <c>transmitting</c> flag, the conversation budget,
/// <c>SmtpFailureClassifier</c>, the quiet QUIT — and all of it encodes four B6 review findings
/// about a contractor's client receiving two copies of his diary. **None of it applies to an
/// invite, because a duplicate invite is harmless.** Refactoring the money path to share a
/// connect-and-authenticate block would put those findings at risk to save about twenty lines.
/// </para>
/// <para>
/// What <i>is</i> shared is the thing that should be: the configuration. Both read
/// <see cref="ReportingOptions"/>, so there is exactly one relay to set up, one From address, and
/// no way for invites to work while reports do not.
/// </para>
/// <para>
/// Locally, <c>docker compose</c> runs Mailpit on 1025, so this path is provable end to end with
/// no relay account at all. <b>Never point it at port 25 on the VPS</b> — Hetzner blocks outbound
/// 25 and a fresh address has no sending reputation.
/// </para>
/// </summary>
public sealed class SmtpMailSender(
    IOptions<ReportingOptions> options, ILogger<SmtpMailSender> logger) : IMailSender
{
    private readonly ReportingOptions _options = options.Value;

    public bool IsConfigured => _options.IsConfigured;

    public async Task SendAsync(Core.Mail.MailMessage message, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(message);

        if (!IsConfigured)
        {
            // Callers are expected to have asked IsConfigured first and chosen another channel.
            // Reaching here is a wiring mistake, and it says so rather than failing quietly.
            throw new InvalidOperationException(
                "No mail relay is configured. Set Reporting:Smtp:Host and Reporting:FromAddress "
                + "(locally, docker compose runs Mailpit on localhost:1025).");
        }

        var mime = Build(message);

        using var client = new SmtpClient { Timeout = (int)_options.Smtp.Timeout.TotalMilliseconds };

        // MailKit's Timeout bounds one protocol operation, not the whole conversation. Same
        // ceiling the report path applies, for the same reason: without it a wedged relay holds a
        // Hangfire worker indefinitely.
        using var conversation = CancellationTokenSource.CreateLinkedTokenSource(ct);
        conversation.CancelAfter(_options.Smtp.ConversationBudget);

        await client.ConnectAsync(
            _options.Smtp.Host,
            _options.Smtp.Port,
            SocketOptions(_options.Smtp.Security),
            conversation.Token);

        if (!string.IsNullOrWhiteSpace(_options.Smtp.Username))
        {
            await client.AuthenticateAsync(
                _options.Smtp.Username, _options.Smtp.Password, conversation.Token);
        }

        var response = await client.SendAsync(mime, conversation.Token);

        try
        {
            await client.DisconnectAsync(quit: true, conversation.Token);
        }
        catch (Exception ex)
        {
            // The relay already answered. A socket that dies on the way to QUIT changes nothing.
            logger.LogWarning(ex, "The mail relay connection did not close cleanly.");
        }

        // No address and no subject: this line goes to the log stream a super admin can read
        // (ARCHITECTURE §12 — personal data stays out of logs). The relay's own words are safe.
        logger.LogInformation("Mail handed to the relay: {Response}", response?.Trim());
    }

    private MimeMessage Build(Core.Mail.MailMessage message)
    {
        var mime = new MimeMessage();
        mime.From.Add(new MailboxAddress(_options.FromName, _options.FromAddress));
        mime.To.Add(new MailboxAddress(message.ToName ?? string.Empty, message.ToAddress));

        if (!string.IsNullOrWhiteSpace(_options.ReplyToAddress))
        {
            mime.ReplyTo.Add(MailboxAddress.Parse(_options.ReplyToAddress));
        }

        mime.Subject = message.Subject;
        mime.Body = new MultipartAlternative
        {
            new TextPart(TextFormat.Plain) { Text = message.TextBody },
            new TextPart(TextFormat.Html) { Text = message.HtmlBody },
        };

        return mime;
    }

    private static SecureSocketOptions SocketOptions(SmtpSecurity security) => security switch
    {
        SmtpSecurity.None => SecureSocketOptions.None,
        SmtpSecurity.StartTls => SecureSocketOptions.StartTls,
        SmtpSecurity.SslOnConnect => SecureSocketOptions.SslOnConnect,
        _ => SecureSocketOptions.Auto,
    };
}
