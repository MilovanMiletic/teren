namespace Teren.Core.Text;

/// <summary>
/// Which of the product's two languages a stored tag means.
///
/// <para>
/// <b>The rule was written three times and one of the three disagreed.</b> <c>ReportStrings</c> and
/// the worker-invite copy both trimmed, lower-cased and accepted <c>en</c>, <c>en-us</c> and
/// <c>en-gb</c>; the admin-invite copy did an <c>OrdinalIgnoreCase</c> comparison against
/// <c>"en"</c> alone. So the same account, with <c>language = "en-US"</c>, would get an English
/// report, an English activation message and a <b>Serbian</b> invitation to set his password —
/// which is the one of the three a person receives before he has ever seen the product, and the
/// one that has to convince him to click a link. Nothing writes <c>en-US</c> today
/// (<c>WorkerEndpoints.LanguageOf</c> narrows to <c>en</c> or <c>sr</c> on the way in), so this was
/// a bug waiting on a seeder, an import or an admin screen that offers a browser's locale.
/// </para>
///
/// <para>
/// <b>Unrecognised is Serbian, everywhere, and that is not a fallback so much as the default.</b>
/// The users are Serbian tradesmen and their bosses; English is the translation. A tag nobody can
/// parse must not stop a report, an invite or a code from going out.
/// </para>
/// </summary>
public static class LanguageTag
{
    public const string Serbian = "sr";
    public const string English = "en";

    /// <summary>The language a stored tag means when it is not the default.</summary>
    public static bool IsEnglish(string? language) =>
        Normalise(language) is "en" or "en-us" or "en-gb";

    /// <summary>
    /// A stored tag reduced to one of the two the product ships, so that what is written to
    /// <c>app_user.language</c> is a value every reader of it already agrees about.
    /// </summary>
    public static string Of(string? language) => IsEnglish(language) ? English : Serbian;

    private static string Normalise(string? language) =>
        (language ?? string.Empty).Trim().ToLowerInvariant();
}
