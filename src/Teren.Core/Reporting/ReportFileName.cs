using System.Globalization;
using System.Text;

namespace Teren.Core.Reporting;

/// <summary>
/// The name the PDF arrives with in the client's inbox.
/// <para>
/// It is worth doing properly: a client who receives one of these a day files them by name, and
/// "attachment.pdf" is how a report stops being evidence anybody can find. So it carries the
/// site and the date, in that order, and it is folded to ASCII — Serbian diacritics survive mail
/// transport badly across old clients and Windows shares, and a report the client cannot save is
/// worse than one with a plain name.
/// </para>
/// <para>
/// Object keys are a different matter entirely and never contain any of this
/// (<c>ObjectKeys</c>): the file name is for a human who already has the report, the key is a
/// server-side identifier that must leak nothing.
/// </para>
/// </summary>
public static class ReportFileName
{
    private const int MaxSiteLength = 60;

    public static string ForDaily(ReportStrings strings, string projectName, DateOnly date)
    {
        var stem = string.Format(
            CultureInfo.InvariantCulture,
            strings.AttachmentNameStem,
            date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

        var site = Slug(projectName);

        return site.Length == 0 ? $"{stem}.pdf" : $"{stem}-{site}.pdf";
    }

    /// <summary>
    /// ASCII, hyphen-separated, bounded. Serbian Latin letters fold to their base form the way a
    /// Serbian reader would spell them without a keyboard: đ becomes <c>dj</c>, everything else
    /// loses its diacritic.
    /// </summary>
    public static string Slug(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length);

        foreach (var character in value)
        {
            switch (character)
            {
                // Not decomposable: đ/Đ is a distinct letter, not d with a mark, so
                // normalisation leaves it alone and it has to be spelled out.
                case 'đ':
                case 'Đ':
                    builder.Append("dj");
                    continue;
            }

            // NFD splits č into c + combining caron; dropping the marks leaves the base letter.
            foreach (var decomposed in character.ToString().Normalize(NormalizationForm.FormD))
            {
                if (CharUnicodeInfo.GetUnicodeCategory(decomposed)
                    == UnicodeCategory.NonSpacingMark)
                {
                    continue;
                }

                if (char.IsAsciiLetterOrDigit(decomposed))
                {
                    builder.Append(char.ToLowerInvariant(decomposed));
                }
                else if (builder.Length > 0 && builder[^1] != '-')
                {
                    builder.Append('-');
                }
            }
        }

        var slug = builder.ToString().Trim('-');

        if (slug.Length > MaxSiteLength)
        {
            slug = slug[..MaxSiteLength].TrimEnd('-');
        }

        return slug;
    }
}
