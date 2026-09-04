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
    /// send. <b>Corrected 2026-09-04:</b> this used to say the set-password link "comes back in the
    /// response body for him to read down the phone" — that stopped being true in D6, which took the
    /// plaintext out of every response body. The token is minted inside <c>AdminInviteJob</c> and
    /// mailed; with no relay the invite is <b>refused visibly</b> (<c>emailed: false</c>) and the CLI
    /// <c>invite-admin</c> is the way in, because shell on that box already means the database.
    ///
    /// <para>
    /// <b>Not sufficient on its own.</b> A relay with no <c>Auth:AppUrl</c> can build no link at all,
    /// and gating on this property alone is exactly how the invite screen came to claim a send it had
    /// not made while retiring the previous working link. See <c>PasswordTokens.CanLink</c>.
    /// </para>
    ///
    /// <para>
    /// Standing policy is visible failure over silent invention — nothing here ever pretends a mail
    /// went out.
    /// </para>
    /// </summary>
    bool IsConfigured { get; }

    /// <summary>Sends it, or throws. No receipt: SMTP has nothing worth returning.</summary>
    Task SendAsync(MailMessage message, CancellationToken ct);
}
