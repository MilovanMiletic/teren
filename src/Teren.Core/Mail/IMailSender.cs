namespace Teren.Core.Mail;

/// <summary>
/// Sends a <see cref="MailMessage"/>, or says plainly that it cannot.
///
/// <para>
/// <b>Deliberately far simpler than <c>IReportDelivery</c>.</b> That interface exists to answer
/// "does the relay hold a copy of this client's diary, and may I safely send it again?" — the
/// question that decides whether a customer gets two copies of the same day. This one answers
/// only "did it go". A duplicate invite is harmless, so there is no custody window, no receipt and
/// no failure taxonomy: it either sends or it throws, and the caller is a background job whose
/// retry policy is its own.
/// </para>
/// </summary>
public interface IMailSender
{
    /// <summary>
    /// Whether a relay is configured at all.
    ///
    /// <para>
    /// Read by callers <b>before</b> they decide how to deliver a credential, not merely to skip a
    /// send: with no relay, the set-password link has to reach the founder some other way, and §9
    /// says it comes back in the response body for him to read down the phone. Standing policy is
    /// visible failure over silent invention — nothing here ever pretends a mail went out.
    /// </para>
    /// </summary>
    bool IsConfigured { get; }

    /// <summary>Sends it, or throws. No receipt: SMTP has nothing worth returning.</summary>
    Task SendAsync(MailMessage message, CancellationToken ct);
}
