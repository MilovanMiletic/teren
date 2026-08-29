using System.Net.Sockets;
using MailKit.Net.Smtp;
using MailKit.Security;
using Teren.Core.Reporting;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// Where an SMTP failure is turned into a verdict, proven without opening a socket.
/// <para>
/// The interesting axis is not the exception type — it is <b>where in the conversation it
/// happened</b>. The same broken socket is a free retry before the message transaction begins and
/// a decision a person has to make once it has, because a relay that scans content after DATA
/// more slowly than the budget, or resets after accepting, is indistinguishable from one that
/// never received anything. Retrying resolves that in the client's inbox.
/// </para>
/// </summary>
public sealed class SmtpFailureClassifierTests
{
    private const string Transport = "smtp";

    public static TheoryData<Exception> AmbiguousFailures() =>
    [
        new SmtpProtocolException("the relay desynchronised"),
        new IOException("the connection was reset"),
        new TimeoutException("no answer"),
        new OperationCanceledException("the conversation ran out of budget"),
        new SocketException(10054),
        new SslHandshakeException("TLS failed"),
        new InvalidOperationException("something nobody anticipated"),
    ];

    [Theory]
    [MemberData(nameof(AmbiguousFailures))]
    public void Before_the_message_is_transmitted_an_unanswered_relay_is_worth_another_attempt(
        Exception ex)
    {
        var classified = SmtpFailureClassifier.Classify(Transport, ex, transmitting: false);

        classified.Kind.ShouldBe(ReportDeliveryFailureKind.Transient);
        classified.Retryable.ShouldBeTrue();
        classified.InnerException.ShouldBeSameAs(ex);
    }

    [Theory]
    [MemberData(nameof(AmbiguousFailures))]
    public void Once_the_message_is_on_the_wire_the_same_silence_is_a_decision_for_a_person(
        Exception ex)
    {
        var classified = SmtpFailureClassifier.Classify(Transport, ex, transmitting: true);

        classified.Kind.ShouldBe(
            ReportDeliveryFailureKind.CustodyUnknown,
            "the relay may already hold the message, and a retry would be a second copy");
        classified.Retryable.ShouldBeFalse();
        classified.InnerException.ShouldBeSameAs(ex);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_relay_that_answered_with_a_permanent_refusal_is_never_ambiguous(bool transmitting)
    {
        // A status code means the relay spoke: it either took the message or explicitly did not.
        // 5xx is a refusal no number of attempts changes — an address it will not accept, a
        // sender it will not relay for.
        var ex = new SmtpCommandException(
            SmtpErrorCode.RecipientNotAccepted,
            SmtpStatusCode.MailboxUnavailable,
            "550 no such mailbox");

        var classified = SmtpFailureClassifier.Classify(Transport, ex, transmitting);

        classified.Kind.ShouldBe(ReportDeliveryFailureKind.Rejected);
        classified.Retryable.ShouldBeFalse();
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_relay_that_answered_not_now_is_retried_wherever_it_said_so(bool transmitting)
    {
        // Greylisting, a full mailbox, a rate limit. The relay answered, so nothing is unknown:
        // it did not take the message and it invited us back.
        var ex = new SmtpCommandException(
            SmtpErrorCode.MessageNotAccepted,
            SmtpStatusCode.MailboxBusy,
            "450 greylisted, try again");

        var classified = SmtpFailureClassifier.Classify(Transport, ex, transmitting);

        classified.Kind.ShouldBe(ReportDeliveryFailureKind.Transient);
        classified.Retryable.ShouldBeTrue();
    }

    [Fact]
    public void A_refused_credential_stays_a_deployment_fault()
    {
        // It can only happen before the message transaction, and no number of attempts conjures
        // a password. Both spellings, because MailKit raises its own and SASL raises another.
        SmtpFailureClassifier.Classify(
                Transport,
                new MailKit.Security.AuthenticationException("535 bad credentials"),
                transmitting: false)
            .Kind.ShouldBe(ReportDeliveryFailureKind.Unauthorized);

        SmtpFailureClassifier.Classify(
                Transport, new SaslException("PLAIN", SaslErrorCode.InvalidChallenge, "no"),
                transmitting: false)
            .Kind.ShouldBe(ReportDeliveryFailureKind.Unauthorized);

        SmtpFailureClassifier.Classify(
                Transport,
                new System.Security.Authentication.AuthenticationException("refused"),
                transmitting: false)
            .Kind.ShouldBe(ReportDeliveryFailureKind.Unauthorized);
    }

    [Fact]
    public void The_verdict_never_quotes_the_relay_back_at_the_foreman()
    {
        // The same discipline B3's upload taxonomy and B4's provider failures follow: a relay
        // rewording its banner must not change what anyone is told. The banner survives on the
        // inner exception, where an operator can read it.
        var ex = new SmtpProtocolException("Ihr Server antwortet nicht");

        var classified = SmtpFailureClassifier.Classify(Transport, ex, transmitting: true);

        classified.Message.ShouldNotContain("Ihr Server");
        classified.InnerException!.Message.ShouldBe("Ihr Server antwortet nicht");
    }
}
