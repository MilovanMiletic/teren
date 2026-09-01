using System.Text.RegularExpressions;
using Teren.Core.Mail;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// A mail sender that posts nothing and keeps everything, plus the one thing tests need to read
/// back out of a message.
///
/// <para>
/// It exists because the set-password link stopped being in any response body on 2026-09-01 — it
/// is minted inside <c>AdminInviteJob</c> and sent to one address. That is better for the product
/// and it means a test can only reach the link the way a person does: out of the mail. Which is
/// the stronger test anyway, and it is what caught nothing before, because nothing looked.
/// </para>
/// </summary>
public sealed class CapturingMailSender(bool configured = true) : IMailSender
{
    public bool IsConfigured { get; } = configured;

    /// <summary>Every message, in order. A list rather than a single slot: the supersede tests send
    /// twice and the second message is the interesting one.</summary>
    public List<MailMessage> Sent { get; } = [];

    public MailMessage? Last => Sent.Count == 0 ? null : Sent[^1];

    public Task SendAsync(MailMessage message, CancellationToken ct)
    {
        Sent.Add(message);
        return Task.CompletedTask;
    }
}

/// <summary>Reading a link back out of a message, the way a person's mail client would.</summary>
public static class InviteMail
{
    /// <summary>
    /// The <c>trn_p_</c> token out of a body.
    ///
    /// <para>
    /// Deliberately parsed out of the rendered text rather than returned by the job. A test that
    /// took the token from a return value could not notice a mail whose body never carried the
    /// link — which is the failure a recipient would actually meet.
    /// </para>
    /// </summary>
    public static string TokenIn(string body)
    {
        var match = Regex.Match(body, @"trn_p_[A-Za-z0-9_\-]+");
        return match.Success
            ? match.Value
            : throw new InvalidOperationException(
                "No set-password token in the message body:\n" + body);
    }

    /// <summary>The whole URL, for the assertions that care that it points at the app.</summary>
    public static string LinkIn(string body)
    {
        var match = Regex.Match(body, @"https?://\S*?/set-password\?token=trn_p_[A-Za-z0-9_\-]+");
        return match.Success
            ? match.Value
            : throw new InvalidOperationException("No set-password link in the message body:\n" + body);
    }
}
