namespace Teren.Core.Mail;

/// <summary>
/// One ordinary transactional email: an invite, a reset link, anything that is not a report.
///
/// <para>
/// <b>Why this is not <c>ReportMessage</c>.</b> That type requires a non-null attachment and
/// always attaches it — the PDF <i>is</i> the report — so an invite cannot use it without lying
/// about its own shape. And <c>IReportDelivery</c> carries a Transient / <b>CustodyUnknown</b> /
/// Rejected distinction that encodes four separate B6 review findings about a client receiving two
/// copies of his diary. None of that applies here: <b>a duplicate invite is harmless</b>, the
/// second link simply supersedes the first. Diluting the report interface into a generic mail one
/// would re-litigate all four findings to serve a case that does not need them
/// (<c>plans/profile-and-identity.md</c> §9).
/// </para>
/// </summary>
public sealed record MailMessage
{
    public required string ToAddress { get; init; }

    /// <summary>The recipient's own name, when there is one to use. Null sends a bare address.</summary>
    public string? ToName { get; init; }

    public required string Subject { get; init; }

    /// <summary>Plain text, always. A mail with no text part is a mail some clients show empty.</summary>
    public required string TextBody { get; init; }

    /// <summary>HTML, always sent alongside the text part rather than instead of it.</summary>
    public required string HtmlBody { get; init; }
}
