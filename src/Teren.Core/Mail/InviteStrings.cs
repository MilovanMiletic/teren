namespace Teren.Core.Mail;

/// <summary>
/// What an invite email says, in the recipient's own language.
///
/// <para>
/// <b>Structurally like <c>ReportStrings</c> and deliberately not part of it.</b> That type is
/// documented as the <i>report's</i> chrome — the words inside a PDF a contractor sends his
/// client — and hanging invite copy off it would make every future report change a mail change.
/// </para>
///
/// <para>
/// <b>The asymmetry worth writing down (§9):</b> a report speaks the <i>project's</i> language,
/// because the client reads it. An invite speaks the <i>recipient's</i>
/// (<c>app_user.language</c>), because he does. They are different people and the rule is not
/// shared.
/// </para>
/// </summary>
public sealed record InviteStrings
{
    public const string DefaultLanguage = "sr";

    public required string Language { get; init; }

    /// <summary>Subject line. Takes the product name.</summary>
    public required string Subject { get; init; }

    public required string Greeting { get; init; }

    /// <summary>What the account is and who made it. Takes the company name.</summary>
    public required string Lead { get; init; }

    /// <summary>The label on the link itself.</summary>
    public required string Action { get; init; }

    /// <summary>That the link dies. Takes the number of hours.</summary>
    public required string Expiry { get; init; }

    /// <summary>What to do when the button does not work — the URL follows.</summary>
    public required string Fallback { get; init; }

    /// <summary>For a person who did not expect this. Says to ignore it, never to click anything.</summary>
    public required string Unexpected { get; init; }

    public static InviteStrings For(string? language) =>
        string.Equals(language, "en", StringComparison.OrdinalIgnoreCase) ? English : Serbian;

    /// <summary>
    /// Serbian, and it is the default rather than the translation — the users are Serbian
    /// tradesmen and their bosses (CLAUDE.md). An unrecognised language lands here too.
    /// </summary>
    public static readonly InviteStrings Serbian = new()
    {
        Language = "sr",
        Subject = "Otvoren vam je nalog u aplikaciji {0}",
        Greeting = "Zdravo,",
        Lead =
            "Otvoren vam je nalog za praćenje gradilišta firme {0}. Da biste ga koristili, "
            + "postavite svoju lozinku.",
        Action = "Postavite lozinku",
        Expiry = "Link važi {0} sata i koristi se jednom.",
        Fallback = "Ako dugme ne radi, otvorite ovu adresu:",
        Unexpected = "Ako niste očekivali ovu poruku, slobodno je zanemarite.",
    };

    public static readonly InviteStrings English = new()
    {
        Language = "en",
        Subject = "An account has been opened for you in {0}",
        Greeting = "Hello,",
        Lead =
            "An account has been opened for you to follow {0}'s sites. Set your password to "
            + "start using it.",
        Action = "Set your password",
        Expiry = "The link is valid for {0} hours and can be used once.",
        Fallback = "If the button does not work, open this address:",
        Unexpected = "If you were not expecting this message, you can ignore it.",
    };
}
