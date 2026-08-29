using System.Net.Sockets;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MimeKit;
using MimeKit.Text;
using Teren.Core.Reporting;

namespace Teren.Infrastructure.Reporting;

/// <summary>
/// Report delivery over SMTP with MailKit (PROJECT.md §11, decided 2026-08-29; MIT licence).
/// <para>
/// A protocol rather than a vendor SDK, so the relay stays swappable: every transactional mail
/// provider offers an SMTP endpoint, and moving between them is configuration, not code.
/// </para>
/// <para>
/// **What this class does not know is as important as what it does.** SMTP hands back one
/// response line and nothing else — no message id you can follow, no bounce, no open, no
/// delivery confirmation (ARCHITECTURE §10). So a <c>250</c> is recorded as
/// <see cref="ReportDeliveryReceipt.HandedOverAt"/>, the relay's exact words go on the report
/// row, and nothing in this system ever claims a client *received* anything.
/// </para>
/// <para>
/// **Never point this at port 25 on the VPS.** Hetzner blocks outbound 25 by default and a
/// fresh VPS address has no sending reputation; a report sent that way is filed as spam, and the
/// report is the product. Use an authenticated relay and put SPF, DKIM and DMARC on the sending
/// domain. Locally, <c>docker compose</c> runs Mailpit on 1025 so this path is provable end to
/// end without any relay account at all.
/// </para>
/// </summary>
public sealed class SmtpReportDelivery(
    IOptions<ReportingOptions> options, ILogger<SmtpReportDelivery> logger) : IReportDelivery
{
    private readonly ReportingOptions _options = options.Value;

    public string Name => "smtp";

    public bool IsConfigured => _options.IsConfigured;

    public bool CanAddress(ReportRecipient recipient) =>
        !string.IsNullOrWhiteSpace(recipient.Email)
        && MailboxAddress.TryParse(recipient.Email, out _);

    public async Task<ReportDeliveryReceipt> SendAsync(ReportMessage message, CancellationToken ct)
    {
        if (!IsConfigured)
        {
            throw new ReportDeliveryException(
                Name,
                "No mail relay is configured. Set Reporting:Smtp:Host and Reporting:FromAddress "
                + "(locally, docker compose runs Mailpit on localhost:1025).",
                ReportDeliveryFailureKind.NotConfigured);
        }

        var mime = BuildMessage(message);

        // No retry loop and no fallback host here: the report pass owns retry policy, the same
        // rule the AI adapters and the S3 client follow (ARCHITECTURE §10). Two stacked retry
        // budgets multiply the worst case that Reporting:StaleAfter has to outlast.
        using var client = new SmtpClient
        {
            Timeout = (int)_options.Smtp.Timeout.TotalMilliseconds,
        };

        // MailKit's Timeout bounds one protocol operation, not the conversation: greeting, AUTH,
        // MAIL FROM, one RCPT TO per recipient, DATA and the upload each get it in full. Without
        // this ceiling the Reporting:StaleAfter arithmetic is a description of a healthy pass
        // rather than a bound on any pass.
        using var conversation = CancellationTokenSource.CreateLinkedTokenSource(ct);
        conversation.CancelAfter(_options.Smtp.ConversationBudget);

        // The whole reason this method is not a straight line: everything before this flips is a
        // failure the pass may safely repeat, and everything after it, until the relay answers,
        // is a failure nobody can safely repeat.
        var transmitting = false;

        try
        {
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

            transmitting = true;
            var response = await client.SendAsync(mime, conversation.Token);
            transmitting = false;

            // Deliberately outside the custody window and deliberately not fatal. The relay has
            // already answered; a socket that dies on the way to QUIT changes nothing about who
            // holds the message, and letting it throw here would turn an accepted report into a
            // retry — which is the duplicate this class exists to avoid.
            await QuitQuietlyAsync(client, conversation.Token);

            // Recipients are named people; the log carries the count, never the addresses
            // (ARCHITECTURE §12: no personal data in logs).
            logger.LogInformation(
                "Report handed to the relay for {RecipientCount} recipient(s): {Response}",
                message.Recipients.Count, response);

            return new ReportDeliveryReceipt(
                Name, Trim(response), DateTimeOffset.UtcNow, message.Recipients.Count);
        }
        catch (ReportDeliveryException)
        {
            throw;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The host is shutting down, which is not a verdict on the relay. Same guard as
            // S3ObjectStorage.PutAsync: wrapping it would record a delivery failure for a report
            // whose fate is simply unknown, and the sweeper is what makes that visible.
            throw;
        }
        catch (Exception ex)
        {
            throw SmtpFailureClassifier.Classify(Name, ex, transmitting);
        }
    }

    private async Task QuitQuietlyAsync(SmtpClient client, CancellationToken ct)
    {
        try
        {
            await client.DisconnectAsync(quit: true, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex, "The mail relay connection did not close cleanly after it took the message.");
        }
    }

    private MimeMessage BuildMessage(ReportMessage message)
    {
        var mime = new MimeMessage
        {
            // Derived from the report row, so it is the *same* header on every attempt at that
            // report — a retry inside one pass, or a later pass reclaiming a failed row. It is
            // the only duplicate suppression SMTP offers: if an ambiguous post-transmission
            // failure ever does end in two copies leaving here, a receiving server can collapse
            // them on this id. MimeKit's own default would generate a fresh random one per
            // message and throw that away.
            MessageId = MessageIdFor(message.ReportId),
        };

        // The display name is the contractor's, because that is who the client believes he is
        // hearing from; the address is ours, because that is the domain the SPF/DKIM records
        // belong to. Both halves matter for the message not being filed as spam.
        mime.From.Add(new MailboxAddress(
            string.IsNullOrWhiteSpace(_options.FromName) ? null : _options.FromName,
            _options.FromAddress));

        if (!string.IsNullOrWhiteSpace(_options.ReplyToAddress)
            && MailboxAddress.TryParse(_options.ReplyToAddress, out var replyTo))
        {
            mime.ReplyTo.Add(replyTo);
        }

        foreach (var recipient in message.Recipients)
        {
            if (!MailboxAddress.TryParse(recipient.Email, out var address))
            {
                // Unreachable: the pass filters with CanAddress before it claims anything. Kept
                // as a refusal rather than a silent skip, because quietly dropping a recipient
                // would make the report row's snapshot a lie about who was written to.
                throw new ReportDeliveryException(
                    Name,
                    "A recipient on the project's distribution list is not a usable address.",
                    ReportDeliveryFailureKind.Rejected);
            }

            address.Name = recipient.Name;
            mime.To.Add(address);
        }

        mime.Subject = message.Subject;

        var body = new BodyBuilder
        {
            TextBody = message.BodyText,
            HtmlBody = message.BodyHtml,
        };

        body.Attachments.Add(
            message.AttachmentFileName,
            message.Attachment,
            ContentType.Parse(message.AttachmentContentType));

        mime.Body = body.ToMessageBody();

        return mime;
    }

    /// <summary>
    /// <c>report.{id}@{sending domain}</c>. The domain half is taken from the configured sender
    /// because that is the domain whose SPF/DKIM records vouch for this mail; a Message-ID on a
    /// domain the message is not sent from is a small but real spam signal.
    /// </summary>
    private string MessageIdFor(Guid reportId)
    {
        var at = _options.FromAddress.LastIndexOf('@');
        var domain = at >= 0 && at < _options.FromAddress.Length - 1
            ? _options.FromAddress[(at + 1)..].Trim()
            : null;

        // MimeKit refuses a Message-ID without a usable right-hand side, and an unparsable
        // FromAddress must not be able to turn a report into an exception on the way out.
        return string.IsNullOrWhiteSpace(domain) || domain.Contains(' ', StringComparison.Ordinal)
            ? $"report.{reportId:N}@teren.invalid"
            : $"report.{reportId:N}@{domain}";
    }

    /// <summary>
    /// <see cref="SmtpSecurity"/> mapped onto MailKit's own vocabulary. <c>Auto</c> lets MailKit
    /// decide from the port and the greeting, which is right for a local catcher and wrong for
    /// anything carrying a real client's report — name the mode there.
    /// </summary>
    private static SecureSocketOptions SocketOptions(SmtpSecurity security) => security switch
    {
        SmtpSecurity.None => SecureSocketOptions.None,
        SmtpSecurity.StartTls => SecureSocketOptions.StartTls,
        SmtpSecurity.SslOnConnect => SecureSocketOptions.SslOnConnect,
        _ => SecureSocketOptions.Auto,
    };

    /// <summary>The relay's response line, bounded: it goes into a text column and a log, and a
    /// chatty relay should not be able to write a paragraph into either.</summary>
    private static string? Trim(string? response)
    {
        if (string.IsNullOrWhiteSpace(response))
        {
            return null;
        }

        var single = response.ReplaceLineEndings(" ").Trim();
        return single.Length <= 300 ? single : single[..300];
    }
}

/// <summary>
/// Builds the covering note that carries the PDF, in the project's language.
/// <para>
/// Both a plain-text and an HTML part, and not only for looks: a transactional message with no
/// text/plain alternative scores worse with spam filters, and half of these are read on a phone
/// in a van.
/// </para>
/// </summary>
public static class ReportMailBody
{
    public static string Subject(ReportStrings strings, string projectName, DateOnly date) =>
        string.Format(
            strings.NumberCulture, strings.EmailSubject, projectName, strings.FormatDate(date));

    public static string Text(
        ReportStrings strings, string companyName, string projectName, DateOnly date) =>
        string.Join(
            Environment.NewLine + Environment.NewLine,
            strings.EmailGreeting,
            string.Format(
                strings.NumberCulture, strings.EmailBody, projectName, strings.FormatDate(date)),
            strings.EmailClosing,
            companyName,
            "--",
            strings.EmailAutomatedNote);

    public static string Html(
        ReportStrings strings, string companyName, string projectName, DateOnly date)
    {
        // Every interpolated value is site data — a project name is a street address someone
        // typed — so all of it is escaped. Inline styles because mail clients strip <style>.
        var greeting = Escape(strings.EmailGreeting);
        var body = Escape(string.Format(
            strings.NumberCulture, strings.EmailBody, projectName, strings.FormatDate(date)));
        var closing = Escape(strings.EmailClosing);
        var company = Escape(companyName);
        var note = Escape(strings.EmailAutomatedNote);

        return $"""
            <!doctype html>
            <html lang="{Escape(strings.Language)}">
            <body style="margin:0;padding:24px;background:#EFEDE8;font-family:Helvetica,Arial,sans-serif;color:#1A1A1A;">
              <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border-radius:12px;padding:24px;">
                <p style="margin:0 0 14px;font-size:15px;line-height:1.5;">{greeting}</p>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">{body}</p>
                <p style="margin:0;font-size:15px;line-height:1.5;">{closing}<br><strong>{company}</strong></p>
                <hr style="border:none;border-top:1px solid #ECE9E3;margin:22px 0 14px;">
                <p style="margin:0;font-size:12px;line-height:1.5;color:#5F5B52;">{note}</p>
              </div>
            </body>
            </html>
            """;
    }

    private static string Escape(string value) =>
        System.Net.WebUtility.HtmlEncode(value);
}
