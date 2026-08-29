using UglyToad.PdfPig;
using UglyToad.PdfPig.DocumentLayoutAnalysis.TextExtractor;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// The words actually on a rendered report, read back out of the PDF.
/// <para>
/// The rest of the render suite asserts on byte counts, which is all you can do without a
/// reader — and a byte count cannot tell "the foreman's words are on the page a client reads"
/// from "something of about that size is". This document is the only part of Teren the client
/// ever sees, so the claims worth making about it are claims about its text.
/// </para>
/// </summary>
public static class PdfText
{
    /// <summary>Every page's text, in reading order, for a human to look at when a test fails.
    /// Assertions go through <see cref="Contains"/>.</summary>
    public static string Of(byte[] pdf)
    {
        using var document = PdfDocument.Open(new MemoryStream(pdf, writable: false));

        return string.Join(
            "\n",
            document.GetPages().Select(page => ContentOrderTextExtractor.GetText(page)));
    }

    /// <summary>
    /// Whether the page carries this text.
    /// <para>
    /// Compared with **all whitespace removed on both sides**, which is not laziness: a PDF has
    /// no space character in the sense a string does — word gaps are glyph positions, and any
    /// reader reconstructs them heuristically. Asserting on reconstructed spacing would make
    /// these tests fail on a line break the layout engine chose, which is a fact about
    /// pagination and not about whether the client can read the sentence. The characters and
    /// their order are the real claim, and this checks exactly that.
    /// </para>
    /// </summary>
    public static bool Contains(byte[] pdf, string text) =>
        Squeeze(Of(pdf)).Contains(Squeeze(text), StringComparison.Ordinal);

    private static string Squeeze(string text) =>
        string.Concat(text.Where(c => !char.IsWhiteSpace(c)));
}
