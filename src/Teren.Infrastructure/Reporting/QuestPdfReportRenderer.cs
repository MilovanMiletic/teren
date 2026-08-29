using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;
using Teren.Core.Reporting;

namespace Teren.Infrastructure.Reporting;

/// <summary>
/// The daily report, laid out with QuestPDF.
/// <para>
/// This document is the product's face: it is the only part of Teren the contractor's client
/// ever sees, and the reason the buyer pays (PROJECT.md §2). It is built to the same palette as
/// the app (<c>design/tokens.md</c>) so the two read as one product, and to the same standard as
/// a document a contractor would put his own name on.
/// </para>
/// <para>
/// **Licensing (ARCHITECTURE §1, re-verified 2026-08-29).** QuestPDF is *not* MIT and not
/// dual-licensed in the usual sense; its own LICENSE.md says "This is a source-available
/// commercial license. It is not an OSI-approved open-source license, and the MIT License does
/// not govern use." The **Community** tier is free for "an organisation with annual gross
/// revenue under USD 1,000,000 in its most recently completed fiscal year, measured on a
/// consolidated basis across entities under common control" — which is Teren for years, and the
/// same threshold §1 already recorded. The library refuses to generate a document until the tier
/// is declared in code, so the declaration lives in this type's static constructor rather than
/// in <c>Program.cs</c>: whatever constructs the renderer — the API, the test host, a future
/// console tool — gets it, and no start-up refactor can quietly drop it. **Revisit before the
/// company's first million.**
/// </para>
/// </summary>
public sealed class QuestPdfReportRenderer : IReportRenderer
{
    /// <summary>The masthead's brand slot, in points. Fixed so the wordmark and a future logo
    /// file occupy identical space and swapping one for the other moves nothing.</summary>
    private const float BrandHeight = 13f;

    // design/tokens.md. The page itself stays white rather than the app's warm `canvas`: a
    // full-bleed tint is a screen affordance and becomes a printing cost on paper.
    private const string Ink = "#1A1A1A";
    private const string Ink2 = "#5F5B52";
    private const string Ink3 = "#A09A8E";
    private const string CardLine = "#ECE9E3";
    private const string Canvas = "#EFEDE8";
    private const string AccentDeep = "#C2410C";
    private const string AccentTint = "#F7E7DF";
    private const string OkInk = "#166534";
    private const string OkTint = "#E4EDE2";
    private const string WarnInk = "#92400E";
    private const string WarnTint = "#F6E8D8";

    /// <summary>Shipped with the QuestPDF package (its <c>LatoFont</c> folder, copied to the
    /// output directory), so the font travels with the application and the report does not depend
    /// on which fonts a Linux container happens to have installed.</summary>
    private const string FontFamily = "Lato";

    static QuestPdfReportRenderer()
    {
        // See the licensing note on the class. Without this, GeneratePdf throws.
        QuestPDF.Settings.License = LicenseType.Community;

        // QuestPDF enables this only when a debugger is attached. Turned on permanently here on
        // purpose: with it off, a character the font cannot draw becomes a placeholder box in a
        // PDF that has already been emailed to an investor. Serbian Latin is entirely made of
        // characters an incomplete font drops — č, ć, š, ž, đ — so this converts the product's
        // worst silent failure into a loud one, at a cost of a little layout time in a
        // background job where nobody is waiting.
        QuestPDF.Settings.CheckIfAllTextGlyphsAreAvailable = true;

        // Only fonts the library itself carries. The founder's Windows machine and a Hetzner
        // container must produce the same document; "whatever fonts the host has" is how they
        // stop doing that.
        QuestPDF.Settings.UseEnvironmentFonts = false;
    }

    private readonly ReportingOptions _options;

    /// <summary>The logo file to draw in the brand slot, or null to draw the wordmark. Resolved
    /// once: this type is a singleton, and re-stat-ing a path per report would be work for
    /// nothing.</summary>
    private readonly string? _brandLogoPath;

    public QuestPdfReportRenderer(
        IOptions<ReportingOptions> options, ILogger<QuestPdfReportRenderer> logger)
    {
        _options = options.Value;

        var configured = _options.BrandLogoPath?.Trim();

        if (!string.IsNullOrEmpty(configured))
        {
            if (File.Exists(configured))
            {
                _brandLogoPath = configured;
            }
            else
            {
                // Loud, once, at start-up — but not fatal. A brand mark is the one thing on this
                // page that carries no evidence, and refusing to send a client his site diary
                // over a mistyped image path would trade something that matters for something
                // that does not. The wordmark is a complete fallback, which is the point of it.
                logger.LogWarning(
                    "Reporting:BrandLogoPath is set to {Path}, which does not exist; reports will "
                    + "carry the {Wordmark} wordmark instead.",
                    configured, _options.BrandWordmark);
            }
        }
    }

    public string Name => "questpdf";

    public byte[] RenderDaily(DailyReport report)
    {
        var s = ReportStrings.For(report.Language);

        // Resolved here, before a single element is laid out, and deliberately allowed to throw.
        // A project whose time_zone nobody can resolve produces no report at all rather than a
        // report whose timestamps are an hour or two wrong — see ReportTimeZone. The report pass
        // turns this into a visible `render_failed` on the entry.
        var zone = ReportTimeZone.Resolve(report.TimeZoneId);

        return Document.Create(document =>
        {
            document.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(36);
                page.DefaultTextStyle(text => text
                    .FontFamily(FontFamily)
                    .FontSize(9.5f)
                    .LineHeight(1.35f)
                    .FontColor(Ink));

                page.Header().Element(header => Masthead(header, report, s));
                page.Content().Element(content => Body(content, report, s, zone));
                page.Footer().Element(footer => Footer(footer, report, s));
            });
        }).GeneratePdf();
    }

    // ------------------------------------------------------------------ masthead

    /// <summary>Repeated on every page, so a page that arrives on its own still says which site
    /// and which day it belongs to.</summary>
    private void Masthead(IContainer container, DailyReport report, ReportStrings s) =>
        container
            .PaddingBottom(14)
            .Column(column =>
            {
                column.Item().Row(row =>
                {
                    row.RelativeItem().Column(left =>
                    {
                        left.Item().Text(report.CompanyName.ToUpperInvariant())
                            .FontSize(7.5f).FontColor(Ink2).Bold().LetterSpacing(0.12f);
                        left.Item().PaddingTop(3).Text(report.ProjectName)
                            .FontSize(15).Bold().FontColor(Ink);

                        if (!string.IsNullOrWhiteSpace(report.ProjectAddress))
                        {
                            left.Item().PaddingTop(1).Text(report.ProjectAddress!)
                                .FontSize(8.5f).FontColor(Ink2);
                        }
                    });

                    // Three lines each side, and the big text sits on line 2 in both columns, so
                    // the project name and the date share a baseline. The brand takes line 3 on
                    // the right against the address on the left — the quietest corner of the
                    // masthead, which is the correct rank: this is the contractor's document, and
                    // Teren is the tool that produced it.
                    row.ConstantItem(150).AlignRight().Column(right =>
                    {
                        right.Item().AlignRight().Text(s.DocumentTitle.ToUpperInvariant())
                            .FontSize(7.5f).Bold().LetterSpacing(0.12f).FontColor(AccentDeep);
                        right.Item().AlignRight().PaddingTop(3).Text(s.FormatDate(report.Date))
                            .FontSize(15).Bold().FontColor(Ink);
                        right.Item().AlignRight().PaddingTop(3).Element(Brand);
                    });
                });

                column.Item().PaddingTop(10).LineHorizontal(1.2f).LineColor(AccentDeep);
            });

    /// <summary>
    /// The Teren mark. Letterspaced type by default — there is no image asset in the repo and
    /// none is expected — set to match the app header's brand (<c>styles.css .bar__brand</c>:
    /// uppercase, bold, ~0.14 em of tracking), so the report and the app read as one product.
    /// <para>
    /// **Swapping in a real logo is one config line and no layout change.** Set
    /// <c>Reporting:BrandLogoPath</c> and the image takes this slot at exactly
    /// <see cref="BrandHeight"/> points; nothing around it moves, because the slot is the same
    /// height either way. Resolved once in the constructor rather than per render, so a path that
    /// does not exist is reported at start-up instead of once per report.
    /// </para>
    /// </summary>
    private void Brand(IContainer container)
    {
        if (_brandLogoPath is not null)
        {
            container.Height(BrandHeight).AlignRight().Image(_brandLogoPath).FitHeight();
            return;
        }

        container
            .Height(BrandHeight)
            .AlignRight()
            .AlignMiddle()
            .Text(_options.BrandWordmark.ToUpperInvariant())
            .FontSize(8.5f).Bold().LetterSpacing(0.18f).FontColor(Ink3);
    }

    private static void Footer(IContainer container, DailyReport report, ReportStrings s) =>
        container
            .PaddingTop(10)
            .BorderTop(0.6f)
            .BorderColor(CardLine)
            .PaddingTop(6)
            .Row(row =>
            {
                row.RelativeItem().Text($"{report.ProjectName} · {s.FormatDate(report.Date)}")
                    .FontSize(7.5f).FontColor(Ink3);

                row.ConstantItem(120).AlignRight().Text(text =>
                {
                    text.DefaultTextStyle(style => style.FontSize(7.5f).FontColor(Ink3));
                    PageNumbers(text, s.PageOf);
                });
            });

    /// <summary>
    /// Renders "Strana {0} / {1}" with live page numbers. The format string stays one localisable
    /// unit — splitting it here rather than hard-coding a separator is what lets a translator
    /// reorder or reword it without touching the layout.
    /// </summary>
    private static void PageNumbers(TextDescriptor text, string format)
    {
        var remaining = format.AsSpan();

        while (!remaining.IsEmpty)
        {
            var next = remaining.IndexOf('{');
            if (next < 0 || next + 2 >= remaining.Length || remaining[next + 2] != '}')
            {
                text.Span(remaining.ToString());
                return;
            }

            if (next > 0)
            {
                text.Span(remaining[..next].ToString());
            }

            switch (remaining[next + 1])
            {
                case '0':
                    text.CurrentPageNumber();
                    break;
                case '1':
                    text.TotalPages();
                    break;
                default:
                    text.Span(remaining.Slice(next, 3).ToString());
                    break;
            }

            remaining = remaining[(next + 3)..];
        }
    }

    // ------------------------------------------------------------------ body

    private void Body(
        IContainer container, DailyReport report, ReportStrings s, TimeZoneInfo zone) =>
        container.Column(column =>
        {
            column.Spacing(16);

            var content = report.Content;

            // First on the page, above the structured sections, because on a verbatim day it
            // *is* the description of the day — and because a reader must meet the statement
            // about where these words came from before he reads them. In the shape the
            // confirmation screen sends (structured sections empty) everything below this is
            // skipped anyway; if a future client ever sends both, nothing is dropped and the
            // prose still leads.
            if (content.HasVerbatimDescription)
            {
                Section(column, s.VerbatimDescription, section =>
                    section.Item().Element(e => VerbatimDescription(e, content.Notes!, s)));
            }

            if (content.WorkDone.Count > 0)
            {
                Section(column, s.WorkDone, section =>
                {
                    section.Spacing(7);
                    foreach (var item in content.WorkDone)
                    {
                        section.Item().Element(e => WorkDoneRow(e, item, s));
                    }
                });
            }

            if (content.Headcount is { } headcount)
            {
                Section(column, s.Workforce, section =>
                    section.Item().Element(e => Workforce(e, headcount, s)));
            }

            if (content.Materials.Count > 0)
            {
                Section(column, s.Materials, section =>
                    section.Item().Element(e => Materials(e, content.Materials, s)));
            }

            // Its own emphasised block, and deliberately not folded into "work done": this is the
            // evidence that cannot be recovered once the wall closes (ARCHITECTURE §6), and it is
            // the single strongest reason the buyer keeps paying.
            if (content.HiddenWork.Count > 0)
            {
                Section(column, s.HiddenWork, section =>
                    section.Item().Element(e => HiddenWork(e, content.HiddenWork, s)));
            }

            if (content.Blockers.Count > 0)
            {
                Section(column, s.Blockers, section =>
                {
                    section.Spacing(6);
                    foreach (var blocker in content.Blockers)
                    {
                        section.Item().Element(e => BlockerRow(e, blocker, s));
                    }
                });
            }

            // `Notes` carries the whole transcript on a verbatim day and it has already been laid
            // out above under its own heading. Printing it a second time as "Napomene" would put
            // the same words on the page twice, the second time with no statement of where they
            // came from — which is precisely the confusion this variant exists to prevent.
            if (!content.HasVerbatimDescription && !string.IsNullOrWhiteSpace(content.Notes))
            {
                Section(column, s.Notes, section =>
                    section.Item().Text(content.Notes!).FontSize(9.5f));
            }

            if (report.Photos.Count > 0)
            {
                Section(column, s.Photos, section =>
                    section.Item().Element(e => Photos(e, report.Photos, s, zone)));
            }

            column.Item().Element(e => RecordDetails(e, report, s, zone));
        });

    /// <summary>A titled block. The heading rule is what gives the page its structure at a
    /// glance — a client scanning it on a phone should find "Skriveni radovi" without reading.</summary>
    private static void Section(ColumnDescriptor column, string heading, Action<ColumnDescriptor> body) =>
        column.Item().Column(section =>
        {
            section.Item()
                .PaddingBottom(5)
                .BorderBottom(0.6f)
                .BorderColor(CardLine)
                .Text(heading.ToUpperInvariant())
                .FontSize(7.5f).Bold().LetterSpacing(0.12f).FontColor(AccentDeep);

            section.Item().PaddingTop(7).Column(body);
        });

    private static void WorkDoneRow(IContainer container, WorkDoneItem item, ReportStrings s) =>
        container.Row(row =>
        {
            row.ConstantItem(10).PaddingTop(4).Text("—").FontSize(9).FontColor(Ink3);

            row.RelativeItem().Column(cell =>
            {
                cell.Item().Text(item.Description).FontSize(10);

                var meta = new List<string>(2);
                if (!string.IsNullOrWhiteSpace(item.Location))
                {
                    meta.Add($"{s.Location}: {item.Location}");
                }

                if (item.Quantity is { } quantity)
                {
                    var formatted = s.FormatQuantity(quantity);
                    if (formatted.Length > 0)
                    {
                        meta.Add($"{s.Quantity}: {formatted}");
                    }
                }

                if (meta.Count > 0)
                {
                    cell.Item().PaddingTop(1).Text(string.Join("  ·  ", meta))
                        .FontSize(8.5f).FontColor(Ink2);
                }
            });
        });

    private static void Workforce(IContainer container, ReportHeadcount headcount, ReportStrings s) =>
        container.Row(row =>
        {
            if (headcount.Total is { } total)
            {
                row.AutoItem()
                    .Background(Canvas)
                    .PaddingVertical(5)
                    .PaddingHorizontal(10)
                    .Text(text =>
                    {
                        text.Span($"{s.WorkersOnSite}  ").FontSize(9).FontColor(Ink2);
                        text.Span(total.ToString(s.NumberCulture)).FontSize(12).Bold();
                    });
            }

            if (headcount.Roles.Count > 0)
            {
                row.RelativeItem().PaddingLeft(headcount.Total is null ? 0 : 12).AlignMiddle()
                    .Text(string.Join(
                        "  ·  ",
                        headcount.Roles.Select(role => role.Count is { } count
                            ? $"{role.Role} × {count.ToString(s.NumberCulture)}"
                            : role.Role)))
                    .FontSize(9).FontColor(Ink2);
            }
        });

    private static void Materials(
        IContainer container, IReadOnlyList<MaterialItem> materials, ReportStrings s) =>
        container.Table(table =>
        {
            table.ColumnsDefinition(columns =>
            {
                columns.RelativeColumn(5);
                columns.RelativeColumn(2);
                columns.ConstantColumn(78);
            });

            table.Header(header =>
            {
                HeaderCell(header.Cell(), s.Materials);
                HeaderCell(header.Cell(), s.Quantity);
                HeaderCell(header.Cell().AlignRight(), s.Delivered);
            });

            foreach (var material in materials)
            {
                table.Cell().Element(BodyCell).Text(material.Name).FontSize(9.5f);

                table.Cell().Element(BodyCell)
                    .Text(material.Quantity is { } quantity ? s.FormatQuantity(quantity) : "—")
                    .FontSize(9.5f).FontColor(Ink2);

                table.Cell().Element(BodyCell).AlignRight().Element(cell =>
                {
                    if (material.Delivered is not { } delivered)
                    {
                        cell.Text("—").FontSize(9.5f).FontColor(Ink3);
                        return;
                    }

                    cell.AlignRight()
                        .Background(delivered ? OkTint : WarnTint)
                        .PaddingVertical(2)
                        .PaddingHorizontal(7)
                        .Text(delivered ? s.Yes : s.No)
                        .FontSize(8).Bold()
                        .FontColor(delivered ? OkInk : WarnInk);
                });
            }

            static void HeaderCell(IContainer cell, string label) =>
                cell.PaddingBottom(4)
                    .BorderBottom(0.6f).BorderColor(CardLine)
                    .Text(label.ToUpperInvariant())
                    .FontSize(7).Bold().LetterSpacing(0.1f).FontColor(Ink3);

            static IContainer BodyCell(IContainer cell) =>
                cell.PaddingVertical(4).BorderBottom(0.4f).BorderColor(CardLine);
        });

    private static void HiddenWork(
        IContainer container, IReadOnlyList<HiddenWorkItem> items, ReportStrings s) =>
        container
            .Background(AccentTint)
            .Padding(11)
            .Column(card =>
            {
                card.Spacing(5);

                foreach (var item in items)
                {
                    card.Item().Row(row =>
                    {
                        row.ConstantItem(10).PaddingTop(4).Text("—").FontSize(9).FontColor(AccentDeep);
                        row.RelativeItem().Text(item.Description).FontSize(10);
                    });
                }

                card.Item().PaddingTop(3).Text(s.HiddenWorkNote)
                    .FontSize(8).Italic().FontColor(Ink2);
            });

    /// <summary>
    /// The day in the foreman's own words: the honesty line, then the transcript set as a quoted
    /// passage.
    /// <para>
    /// **The two halves are typographically different on purpose.** The note is small and italic
    /// — the document speaking about itself, the same voice as the hidden-work note. The words
    /// are set larger and looser than ordinary body text, behind a rule, because they are a
    /// person speaking and a client has to be able to read a paragraph of continuous speech
    /// rather than skim a list. Nothing here is styled to look like extracted data, which is the
    /// whole point: a reader must be able to tell "the system understood five work items" from
    /// "the foreman described his day like this".
    /// </para>
    /// </summary>
    private static void VerbatimDescription(IContainer container, string text, ReportStrings s) =>
        container.Column(block =>
        {
            block.Item().PaddingBottom(8).Text(s.VerbatimNote)
                .FontSize(8).Italic().FontColor(Ink2);

            block.Item()
                .BorderLeft(2)
                .BorderColor(Ink3)
                .PaddingLeft(11)
                .Column(quote =>
                {
                    quote.Spacing(6);

                    // Line breaks in a transcript are the only paragraphing it has — a provider
                    // that returns one unbroken run gives one paragraph, which is correct, and a
                    // provider that segments by utterance gives several. Split rather than handed
                    // to QuestPDF whole so the gap between paragraphs is real spacing instead of
                    // an empty line's worth of leading.
                    foreach (var paragraph in Paragraphs(text))
                    {
                        quote.Item().Text(paragraph).FontSize(10.5f).LineHeight(1.55f);
                    }
                });
        });

    /// <summary>Non-blank lines, trimmed. Never empty for a non-blank input, so the quote block
    /// cannot come out as a bare rule with nothing beside it.</summary>
    private static IReadOnlyList<string> Paragraphs(string text)
    {
        var lines = text
            .Split('\n')
            .Select(line => line.Trim('\r', ' ', '\t'))
            .Where(line => line.Length > 0)
            .ToList();

        return lines.Count > 0 ? lines : [text.Trim()];
    }

    private static void BlockerRow(IContainer container, BlockerItem blocker, ReportStrings s) =>
        container.Row(row =>
        {
            row.ConstantItem(10).PaddingTop(4).Text("—").FontSize(9).FontColor(Ink3);

            row.RelativeItem().Column(cell =>
            {
                cell.Item().Text(blocker.Description).FontSize(10);

                if (!string.IsNullOrWhiteSpace(blocker.WaitingOn))
                {
                    cell.Item().PaddingTop(1).Text($"{s.WaitingOn}: {blocker.WaitingOn}")
                        .FontSize(8.5f).FontColor(Ink2);
                }
            });
        });

    // ------------------------------------------------------------------ photos

    /// <summary>
    /// Two to a row, each with the evidence that makes it a photograph of record rather than a
    /// picture: when the phone took it, and the first bytes of the checksum that was verified
    /// against the capture before it was placed here.
    /// </summary>
    private void Photos(
        IContainer container,
        IReadOnlyList<ReportPhoto> photos,
        ReportStrings s,
        TimeZoneInfo zone) =>
        container.Column(grid =>
        {
            grid.Spacing(10);

            for (var index = 0; index < photos.Count; index += 2)
            {
                var left = photos[index];
                var right = index + 1 < photos.Count ? photos[index + 1] : null;
                var leftNumber = index + 1;

                grid.Item().Row(row =>
                {
                    row.RelativeItem().Element(cell => Photo(cell, left, leftNumber, s, zone));
                    row.ConstantItem(10);

                    if (right is null)
                    {
                        row.RelativeItem();
                    }
                    else
                    {
                        row.RelativeItem()
                            .Element(cell => Photo(cell, right, leftNumber + 1, s, zone));
                    }
                });
            }
        });

    private void Photo(
        IContainer container,
        ReportPhoto photo,
        int number,
        ReportStrings s,
        TimeZoneInfo zone) =>
        container.Column(cell =>
        {
            cell.Item()
                .Background(Canvas)
                .MaxHeight(210)
                .Image(photo.FilePath)
                // Re-encoded rather than embedded as captured: twenty originals at print DPI
                // make an attachment relays refuse, and the phone already compressed these to
                // 1600 px / JPEG ~80.
                .WithRasterDpi(_options.PhotoRasterDpi)
                .WithCompressionQuality(ImageCompressionQuality.High)
                .FitArea();

            var caption = string.Format(s.NumberCulture, s.PhotoCaption, number);
            var captured = photo.CapturedAt is { } moment
                ? $"  ·  {s.FormatTimestamp(moment, zone)}"
                : string.Empty;

            cell.Item().PaddingTop(4).Text($"{caption}{captured}")
                .FontSize(7.5f).FontColor(Ink2);

            cell.Item().Text($"{s.Checksum} {photo.Sha256[..16]}…")
                .FontSize(6.5f).FontColor(Ink3);
        });

    // ------------------------------------------------------------------ provenance

    /// <summary>
    /// What turns the document into evidence: where the day was recorded, when the phone captured
    /// it, when the server took custody, and the statement that every photograph's checksum was
    /// checked.
    /// <para>
    /// **There is deliberately no record id on this page** (founder, 2026-08-29, PROJECT.md §11).
    /// A GUID means nothing to an investor. The accepted trade-off is that a disputed PDF is
    /// matched back to the archive by **project + date**.
    /// </para>
    /// <para>
    /// <b>That is unambiguous only while one entry produces at most one report per project per
    /// day</b> — which <c>ux_report_entry_id</c> and the daily-report shape guarantee today
    /// (ARCHITECTURE §6). The day that changes — a second report for the same site and date, a
    /// weekly recap that supersedes a daily, a correction entry re-reported under its original
    /// date — project + date stops identifying one document and this decision has to be revisited.
    /// Nobody will remember that, which is why it is written here next to the line that would
    /// have to come back.
    /// </para>
    /// </summary>
    private static void RecordDetails(
        IContainer container, DailyReport report, ReportStrings s, TimeZoneInfo zone) =>
        container
            .PaddingTop(4)
            .BorderTop(0.6f)
            .BorderColor(CardLine)
            .PaddingTop(9)
            .Column(column =>
            {
                var provenance = report.Provenance;

                column.Item().Text(s.RecordSection.ToUpperInvariant())
                    .FontSize(7).Bold().LetterSpacing(0.1f).FontColor(Ink3);

                column.Item().PaddingTop(5).Column(details =>
                {
                    details.Spacing(1.5f);

                    // A place, not a position. Coordinates were what this line used to print and
                    // a reader could do nothing with them; a street address he can drive to.
                    // The name is the fallback, because a project always has one.
                    Detail(
                        details,
                        s.Site,
                        string.IsNullOrWhiteSpace(report.ProjectAddress)
                            ? report.ProjectName
                            : report.ProjectAddress!);

                    // Said twice, and that is not redundancy. The block above tells a reader
                    // skimming the day what he is reading; this tells a reader checking the
                    // document's standing — the one who reads this section at all — the same
                    // thing in the place he looks for provenance. Both are gated on there
                    // actually being a transcript, so neither can claim one that is not there.
                    if (report.Content.HasVerbatimDescription)
                    {
                        Detail(details, s.RecordKind, s.RecordKindVerbatim);
                    }

                    Detail(details, s.CapturedAt, s.FormatTimestamp(provenance.CapturedAt, zone));

                    if (provenance.ReceivedAt is { } receivedAt)
                    {
                        Detail(details, s.ReceivedAt, s.FormatTimestamp(receivedAt, zone));
                    }

                    Detail(details, s.GeneratedAt, s.FormatTimestamp(provenance.GeneratedAt, zone));
                });

                if (report.Photos.Count > 0)
                {
                    column.Item().PaddingTop(7).Text(s.EvidenceNote)
                        .FontSize(7.5f).FontColor(Ink2);
                }

                static void Detail(ColumnDescriptor column, string label, string value) =>
                    column.Item().Row(row =>
                    {
                        row.ConstantItem(120).Text(label).FontSize(8).FontColor(Ink2);
                        row.RelativeItem().Text(value).FontSize(8).FontColor(Ink);
                    });
            });
}
