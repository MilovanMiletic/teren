using System.Globalization;
using Teren.Core.Reporting;
using Teren.Core.Text;

namespace Teren.Core.Mail;

/// <summary>
/// Which change of administrative access a company's other administrators are being told about.
///
/// <para>
/// An enum rather than a string, and that is not style: it is the argument a Hangfire job takes,
/// and <b>no credential may ever be a Hangfire argument</b> — arguments are serialised into
/// Hangfire's own storage and kept in job history. Keeping every mail job's arguments to ids,
/// enums and timestamps makes "there is no credential in there" a property a test can check
/// mechanically instead of a claim in a comment (<c>MailJobArgumentTests</c>).
/// </para>
/// </summary>
public enum AdminAccessNotice
{
    /// <summary>Teren staff created a new administrator account inside this company.</summary>
    AdministratorAdded,

    /// <summary>
    /// Teren staff had a set-password link sent for one of this company's administrator accounts —
    /// an invite for an account that never had a password, or a reset of one that has.
    /// <para>
    /// The two are deliberately one notice. The fact the other administrators need is the same in
    /// both cases: somebody outside the company can now set the password on that account. Which of
    /// the two it was is on the audit trail (<c>password_token_issued</c> carries the purpose).
    /// </para>
    /// </summary>
    CredentialIssued,
}

/// <summary>
/// What a company's other administrators are told when Teren staff touch administrative access
/// inside their company.
///
/// <para>
/// <b>This mail is the mechanism behind a sentence the product may now say out loud:</b> minting or
/// resetting an administrator's credential in a customer's company is possible, is audited, and
/// emails every other administrator of that company — so it cannot be done without the customer
/// being told. The capability itself has to exist (a customer's first admin has to come from
/// somewhere, and "our only admin left the company" is a real support case); what must not exist
/// is a way to use it <em>silently</em>.
/// </para>
///
/// <para>
/// <b>It carries no credential and never will.</b> No token, no link, no code, not even a
/// suggestion to click something — it is a statement that something happened. That is also why it
/// says so in as many words: a security notice that trained people to expect a link inside it
/// would be the best phishing template this product could possibly ship.
/// </para>
///
/// <para>
/// <b>Language.</b> The recipient's own (<c>app_user.language</c>), by the one rule the whole
/// product uses (<see cref="LanguageTag"/>). This is "the company's language" in the only form the
/// schema has one: <c>company</c> carries no language column, and the recipients <em>are</em> the
/// company's own people. Same asymmetry as everywhere else — a report speaks the project's
/// language because the client reads it; this speaks the administrator's, because he does.
/// </para>
///
/// <para>
/// <b>Why the timestamp comes from <see cref="ReportStrings.FormatTimestamp"/></b> when
/// <see cref="AdminInviteStrings"/> deliberately keeps its own copy apart from that type: an
/// instant printed for a person is not report copy, it is the one formatting rule this product has
/// (date, wall-clock time, and the offset actually in force, so a reader can recover the exact
/// moment). A second implementation of it is what <c>SharedHelperTests</c> exists to prevent, and a
/// security notice whose time is an hour out is a notice nobody can reconcile with anything.
/// </para>
///
/// <para>
/// The Serbian and English copy is drafted by Claude and <b>owes the founder's review</b> — this is
/// customer-visible mail in his product's voice, and it arrives at a bad moment by definition.
/// </para>
/// </summary>
public sealed record AdminAccessNoticeStrings
{
    public const string DefaultLanguage = LanguageTag.Serbian;

    public required string Language { get; init; }

    /// <summary>Subject line for a new administrator. Takes the company name.</summary>
    public required string SubjectAdministratorAdded { get; init; }

    /// <summary>Subject line for an issued credential. Takes the company name.</summary>
    public required string SubjectCredentialIssued { get; init; }

    public required string Greeting { get; init; }

    /// <summary>What happened, for a new account. <c>{0}</c> company, <c>{1}</c> the person's
    /// name, <c>{2}</c> his address — the address is the whole point: it is how an administrator
    /// recognises that the new account is not one of his own people.</summary>
    public required string LeadAdministratorAdded { get; init; }

    /// <summary>The same three, for a credential issued on an existing account.</summary>
    public required string LeadCredentialIssued { get; init; }

    /// <summary>When it happened. Takes the formatted local timestamp.</summary>
    public required string At { get; init; }

    /// <summary>
    /// Why this person is being written to.
    /// <para>
    /// It deliberately takes no company name: the company has been named twice already, and a
    /// Serbian company name ends in <c>d.o.o.</c> — so a sentence that put one at its end printed
    /// <c>d.o.o..</c>, two dots in a security notice. Same trap the report's date sentence has and
    /// the invite email's first line had; found by reading a rendered message rather than a
    /// template, which is the only way any of the three were found.
    /// </para>
    /// </summary>
    public required string Why { get; init; }

    /// <summary>That there is nothing in here to click or type. Anti-phishing, and true.</summary>
    public required string NoCredentialHere { get; init; }

    /// <summary>What to do if this was not agreed.</summary>
    public required string Unexpected { get; init; }

    public static AdminAccessNoticeStrings For(string? language) =>
        LanguageTag.IsEnglish(language) ? English : Serbian;

    public string SubjectFor(AdminAccessNotice notice, string companyName) =>
        string.Format(
            CultureInfo.InvariantCulture,
            notice == AdminAccessNotice.AdministratorAdded
                ? SubjectAdministratorAdded
                : SubjectCredentialIssued,
            companyName);

    /// <summary>
    /// The message, as plain text. Five short paragraphs: what happened, when, why you are being
    /// told, that there is nothing here to click, and what to do if nobody agreed to it.
    /// </summary>
    /// <param name="notice">Which change this is.</param>
    /// <param name="companyName">The customer's own name, as the contractor wrote it.</param>
    /// <param name="personName">The administrator the change is about.</param>
    /// <param name="personEmail">His address — the fact that answers "is this one of ours?".</param>
    /// <param name="occurredAt">When the change was made, as stored (UTC).</param>
    /// <param name="zone">The zone to print it in. Required rather than defaulted, for the same
    /// reason <see cref="ReportStrings.FormatTimestamp"/> requires one.</param>
    public string Notice(
        AdminAccessNotice notice,
        string companyName,
        string personName,
        string personEmail,
        DateTimeOffset occurredAt,
        TimeZoneInfo zone)
    {
        ArgumentNullException.ThrowIfNull(zone);

        var lead = string.Format(
            CultureInfo.InvariantCulture,
            notice == AdminAccessNotice.AdministratorAdded
                ? LeadAdministratorAdded
                : LeadCredentialIssued,
            companyName,
            personName,
            personEmail);

        return string.Join(
            "\n\n",
            Greeting,
            lead,
            string.Format(
                CultureInfo.InvariantCulture,
                At,
                ReportStrings.For(Language).FormatTimestamp(occurredAt, zone)),
            Why,
            NoCredentialHere,
            Unexpected);
    }

    public static readonly AdminAccessNoticeStrings Serbian = new()
    {
        Language = "sr",
        SubjectAdministratorAdded = "Dodat je administrator u firmi {0}",
        SubjectCredentialIssued = "Izdat je pristup administratorskom nalogu u firmi {0}",
        Greeting = "Zdravo,",
        LeadAdministratorAdded =
            "Teren podrška je otvorila novi administratorski nalog u firmi {0}: {1} ({2}). Taj "
            + "nalog vidi gradilišta, dnevnike i izveštaje vaše firme.",
        // The company name is mid-sentence on purpose — see `Why`. A name ending in `d.o.o.`
        // followed by a full stop is two dots on the page.
        LeadCredentialIssued =
            "U firmi {0} je Teren podrška poslala poziv za postavljanje lozinke za "
            + "administratorski nalog {1} ({2}). Ko primi taj poziv može da postavi lozinku za taj "
            + "nalog i da vidi gradilišta, dnevnike i izveštaje vaše firme.",
        At = "Vreme: {0}.",
        Why =
            "Ovu poruku dobijate zato što ste administrator u ovoj firmi. O svakoj izmeni "
            + "administratorskog pristupa koju napravi Teren podrška obaveštavamo sve ostale "
            + "administratore firme.",
        NoCredentialHere =
            "U ovoj poruci nema linka ni šifre — ovo je samo obaveštenje. Nemojte nikome slati "
            + "svoju lozinku.",
        Unexpected =
            "Ako ovo nije dogovoreno sa vama, obratite se Teren podršci i tražite da se pristup "
            + "ukine.",
    };

    public static readonly AdminAccessNoticeStrings English = new()
    {
        Language = "en",
        SubjectAdministratorAdded = "An administrator was added to {0}",
        SubjectCredentialIssued = "Access to an administrator account of {0} was issued",
        Greeting = "Hello,",
        LeadAdministratorAdded =
            "Teren support has created a new administrator account in {0}: {1} ({2}). That account "
            + "can see your company's sites, diaries and reports.",
        LeadCredentialIssued =
            "In {0}, Teren support has sent a set-password invitation for the administrator "
            + "account {1} ({2}). Whoever receives it can set that account's password and see your "
            + "company's sites, diaries and reports.",
        At = "Time: {0}.",
        Why =
            "You are receiving this because you are an administrator of this company. Every change "
            + "to administrative access made by Teren support is reported to all of that company's "
            + "other administrators.",
        NoCredentialHere =
            "There is no link and no code in this message — it is a notice and nothing else. Never "
            + "send your password to anyone.",
        Unexpected =
            "If this was not agreed with you, contact Teren support and ask for the access to be "
            + "withdrawn.",
    };
}
