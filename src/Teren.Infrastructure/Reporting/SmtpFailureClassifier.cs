using System.Net.Sockets;
using MailKit.Net.Smtp;
using MailKit.Security;
using Teren.Core.Reporting;

namespace Teren.Infrastructure.Reporting;

/// <summary>
/// Turns whatever the SMTP stack threw into a verdict the report pass can act on.
/// <para>
/// Split out of <see cref="SmtpReportDelivery"/> for one reason: it is the piece where getting it
/// wrong puts a second copy of a client's site diary in his inbox, and it is the only piece that
/// can be proven without opening a socket. Every case below is a test.
/// </para>
/// <para>
/// Two rules, and the second is the one B6's review added:
/// </para>
/// <list type="number">
/// <item>Classify on the exception's <b>type and status code</b>, never on the relay's English
/// banner — the same discipline B3's upload taxonomy and B4's provider failures follow. A relay
/// rewording its greeting must not change whether an entry is retried.</item>
/// <item>Classify on <b>where in the conversation it broke</b>. An ambiguous failure before the
/// message transaction begins is safe to repeat; the same exception after transmission has begun
/// is not, because the relay may already have taken custody and simply failed to say so.</item>
/// </list>
/// </summary>
public static class SmtpFailureClassifier
{
    /// <param name="transport">The transport name, for the exception.</param>
    /// <param name="ex">What the SMTP stack threw.</param>
    /// <param name="transmitting">
    /// Whether the message transaction had begun — i.e. whether the body may already be in the
    /// relay's hands. False during connect, the greeting and AUTH; true from the moment the
    /// message is handed to the client until the relay's final answer comes back.
    /// </param>
    public static ReportDeliveryException Classify(
        string transport, Exception ex, bool transmitting) => ex switch
    {
        // The relay refused our credentials. No number of attempts conjures a password, and this
        // can only happen before the message transaction, so it needs no custody judgement. Both
        // spellings are listed rather than relying on one deriving from the other: MailKit raises
        // its own AuthenticationException, and a SASL negotiation failure is the same class of
        // fault — a credential or mechanism the relay will not take.
        MailKit.Security.AuthenticationException
            or System.Security.Authentication.AuthenticationException
            or SaslException => new ReportDeliveryException(
            transport,
            "The mail relay rejected the configured credentials "
            + "(Reporting:Smtp:Username / Reporting:Smtp:Password).",
            ReportDeliveryFailureKind.Unauthorized,
            ex),

        // A command exception is never ambiguous, wherever it lands: the relay answered with a
        // status code, so it either took the message or explicitly did not. 5xx is a permanent
        // refusal — an address it will not accept, a sender it will not relay for. 4xx is "not
        // now": greylisting, a full mailbox, a rate limit.
        SmtpCommandException smtp when (int)smtp.StatusCode >= 500 => new ReportDeliveryException(
            transport,
            $"The mail relay permanently refused the message ({(int)smtp.StatusCode}).",
            ReportDeliveryFailureKind.Rejected,
            ex),

        SmtpCommandException smtp => new ReportDeliveryException(
            transport,
            $"The mail relay declined the message for now ({(int)smtp.StatusCode}).",
            ReportDeliveryFailureKind.Transient,
            ex),

        // Everything below here is the relay saying nothing at all: a broken socket, a protocol
        // desync, TLS trouble, or a conversation that outran its budget. **Where it happened is
        // the whole verdict.**
        //
        // After transmission began this is the classic duplicate-email vector. A relay that scans
        // content after DATA more slowly than the budget, or resets the connection once it has
        // accepted the message, is indistinguishable from one that never got it — and the
        // difference is decided in the client's inbox. So the pass stops here and a person
        // decides, exactly as it does for a report abandoned by a crash (ARCHITECTURE §6).
        //
        // This is deliberately over-inclusive: a protocol fault at MAIL FROM, before a single
        // byte of the body, is caught by it too and stops an entry a retry would have saved. That
        // is the safe direction to be wrong in. The cost of over-caution is a person clicking
        // resend; the cost of under-caution is an investor holding two copies of the same day.
        SmtpProtocolException or SslHandshakeException or SocketException or IOException
            or OperationCanceledException or TimeoutException => transmitting
            ? CustodyUnknown(transport, ex)
            : new ReportDeliveryException(
                transport,
                "The mail relay could not be reached or did not answer in time, before the "
                + "message was transmitted.",
                ReportDeliveryFailureKind.Transient,
                ex),

        // Nothing anticipated. Same rule: safe to repeat only if the message had not started.
        _ => transmitting
            ? CustodyUnknown(transport, ex)
            : new ReportDeliveryException(
                transport,
                "The mail relay conversation failed before the message was transmitted.",
                ReportDeliveryFailureKind.Transient,
                ex),
    };

    private static ReportDeliveryException CustodyUnknown(string transport, Exception ex) =>
        new(transport,
            "The mail relay stopped answering after the message had begun transmitting, so it "
            + "is not known whether it took the message. It will not be sent again by itself.",
            ReportDeliveryFailureKind.CustodyUnknown,
            ex);
}
