using System.Globalization;
using Teren.Core.Text;

namespace Teren.Core.Reporting;

/// <summary>
/// The report's chrome, in the **project's** language (ARCHITECTURE §6:
/// <c>project.report_language</c>). Serbian is the default because the client is Serbian; an
/// English report comes out of the same machinery when the project says so.
/// <para>
/// Deliberately not Transloco and not a resource file. This is server-side text on a page a
/// client reads, it is a closed set of about thirty strings, and it must be readable next to the
/// layout that uses it. Properties rather than a dictionary lookup so a missing string is a
/// compile error rather than a blank line in an investor's PDF.
/// </para>
/// <para>
/// **Only the chrome is localised.** Work descriptions, material names, units and roles are
/// content and go on the page exactly as they were spoken (CLAUDE.md).
/// </para>
/// <para>
/// The Serbian copy here is written by Claude and still owes the founder's native review of the
/// trade vocabulary (ROADMAP B5 note, ARCHITECTURE §14 decision 7).
/// </para>
/// </summary>
public sealed record ReportStrings
{
    /// <summary>What an unrecognised <c>report_language</c> falls back to — the product's default
    /// and the language of the market it is sold in.</summary>
    public const string DefaultLanguage = LanguageTag.Serbian;

    public required string Language { get; init; }

    /// <summary>
    /// Numbers only. Dates use <see cref="DatePattern"/> and month names never appear, so the
    /// page cannot change shape with an ICU version.
    /// </summary>
    public required CultureInfo NumberCulture { get; init; }

    /// <summary>An explicit pattern rather than a culture's short-date format: a site diary's
    /// date must be unambiguous, and identical on every machine that renders it.</summary>
    public required string DatePattern { get; init; }

    /// <summary>
    /// Date and wall-clock time, with no zone in the pattern: the zone is appended by
    /// <see cref="FormatTimestamp"/> from the offset actually in force on that date, which is the
    /// only way it can be right on both sides of a DST change.
    /// </summary>
    public required string TimestampPattern { get; init; }

    public required string DocumentTitle { get; init; }
    public required string Contractor { get; init; }
    public required string Site { get; init; }
    public required string Date { get; init; }

    public required string WorkDone { get; init; }
    public required string Workforce { get; init; }
    public required string Materials { get; init; }
    public required string HiddenWork { get; init; }
    public required string Blockers { get; init; }
    public required string Notes { get; init; }
    public required string Photos { get; init; }

    public required string Location { get; init; }
    public required string Quantity { get; init; }
    public required string Delivered { get; init; }
    public required string Yes { get; init; }
    public required string No { get; init; }
    public required string WaitingOn { get; init; }
    public required string WorkersOnSite { get; init; }
    public required string NothingRecorded { get; init; }

    public required string HiddenWorkNote { get; init; }

    /// <summary>
    /// Heading of the block that carries the foreman's own words, used instead of the structured
    /// sections when he confirmed his transcript as the day's record.
    /// </summary>
    public required string VerbatimDescription { get; init; }

    /// <summary>
    /// The honesty line, printed above his words. It has one job: a reader must never mistake
    /// this for "the system understood these five work items". It says where the text came from
    /// and, plainly, that nothing broke it down into items — because the pressure to notice that
    /// extraction is broken has to come from somewhere, and this page is the only place a person
    /// is certain to look.
    /// </summary>
    public required string VerbatimNote { get; init; }

    /// <summary>
    /// Heading of the band that says this document corrects an earlier one. Short and in the same
    /// register as a section heading: it sits directly under the masthead rule, where a reader
    /// cannot miss it, because it is the one fact on the page that changes how everything below it
    /// should be read.
    /// </summary>
    public required string CorrectionHeading { get; init; }

    /// <summary>
    /// What the band says when the superseded report actually reached a relay. <c>{0}</c> names
    /// the superseded day, <c>{1}</c> is when that document went out — both in the site's own
    /// local time.
    /// <para>
    /// It has to do two things a footnote could not: tell the reader that a document he *already
    /// has* is wrong, and tell him which one.
    /// </para>
    /// </summary>
    public required string CorrectionOfSentReport { get; init; }

    /// <summary>
    /// The variant for a predecessor no client ever received — a day whose own report failed, or
    /// one still waiting. <c>{0}</c> names the superseded day.
    /// <para>
    /// Kept apart from <see cref="CorrectionOfSentReport"/> rather than softened into one sentence,
    /// because the honest claim is different in the direction that matters: a reader must not be
    /// told he was sent a report that never left the building, and he should not be left hunting
    /// his inbox for it.
    /// </para>
    /// <para>
    /// <b>It states the fact and stops — it must never claim to be the only report for that
    /// day.</b> It said exactly that until the D9 review, and nothing in the money path kept the
    /// promise: re-confirming the predecessor re-queues it and <c>ReportAsync</c> never asks
    /// whether it has been superseded, so a second document for the same day can go out
    /// afterwards; and in a chain (A sent, B failed at the relay, C correcting B) the sent report
    /// for that day is <em>already</em> in the client's inbox while this variant is the one C
    /// prints. The first clause is read from the <c>report</c> row and is a fact; exclusivity was
    /// a promise about the future, on an evidence document.
    /// </para>
    /// </summary>
    public required string CorrectionOfUnsentRecord { get; init; }

    /// <summary>Label of the provenance line that repeats the correction in the evidence block,
    /// where a reader checking the document's standing looks. Same doubling, and same reason, as
    /// <see cref="RecordKind"/>.</summary>
    public required string Corrects { get; init; }

    /// <summary>Label of the provenance line that repeats the same fact in the evidence block,
    /// where a reader checking the document's standing actually looks.</summary>
    public required string RecordKind { get; init; }

    public required string RecordKindVerbatim { get; init; }

    public required string RecordSection { get; init; }
    public required string CapturedAt { get; init; }
    public required string ReceivedAt { get; init; }
    public required string Checksum { get; init; }
    public required string GeneratedAt { get; init; }
    public required string EvidenceNote { get; init; }

    /// <summary><c>{0}</c> current page, <c>{1}</c> total.</summary>
    public required string PageOf { get; init; }

    /// <summary><c>{0}</c> photo number.</summary>
    public required string PhotoCaption { get; init; }

    /// <summary><c>{0}</c> project, <c>{1}</c> date.</summary>
    public required string EmailSubject { get; init; }

    public required string EmailGreeting { get; init; }

    /// <summary><c>{0}</c> project, <c>{1}</c> date.</summary>
    public required string EmailBody { get; init; }

    public required string EmailClosing { get; init; }
    public required string EmailAutomatedNote { get; init; }

    /// <summary>The PDF attachment's file name stem; <c>{0}</c> is the date.</summary>
    public required string AttachmentNameStem { get; init; }

    /// <summary>
    /// Resolves a project's language. Anything not recognised falls back to Serbian rather than
    /// failing the report: a mistyped column must not stop a client's diary arriving.
    /// </summary>
    public static ReportStrings For(string? language) =>
        LanguageTag.IsEnglish(language) ? English : Serbian;

    public string FormatDate(DateOnly date) =>
        date.ToString(DatePattern, CultureInfo.InvariantCulture);

    /// <summary>
    /// How a superseded record is named on the page: its work date, and the site only when that
    /// site is not this report's own (see <see cref="ReportCorrection.SiteName"/>).
    /// <para>
    /// The site name is content and goes on the page exactly as the contractor wrote it; only the
    /// label around it is localised.
    /// </para>
    /// </summary>
    public string FormatSupersededDay(ReportCorrection correction)
    {
        ArgumentNullException.ThrowIfNull(correction);

        var date = FormatDate(correction.Date);

        return string.IsNullOrWhiteSpace(correction.SiteName)
            ? date
            : $"{date}  ·  {Site}: {correction.SiteName!.Trim()}";
    }

    /// <summary>
    /// A stored UTC instant as the site's own wall-clock time.
    /// <para>
    /// The zone is a required argument rather than an optional one on purpose. Every timestamp on
    /// this document is read by someone standing in the project's country, and a UTC overload
    /// sitting beside this one is an hour-wrong evidence document waiting for the next caller who
    /// does not think about it. If you have a moment to print you have a project, and a project
    /// always has a zone (<see cref="ReportTimeZone"/>).
    /// </para>
    /// <para>
    /// The offset is printed alongside the time — <c>29.08.2026. 14:32 (UTC+2)</c> — because this
    /// is evidence: a reader must be able to recover the exact instant, and "14:32" on its own
    /// cannot be reconciled with anything. It is derived from the converted moment, so a summer
    /// entry says UTC+2 and a winter one says UTC+1 with no table for anyone to maintain.
    /// </para>
    /// </summary>
    public string FormatTimestamp(DateTimeOffset moment, TimeZoneInfo zone)
    {
        var local = TimeZoneInfo.ConvertTime(moment, zone);

        return string.Concat(
            local.ToString(TimestampPattern, CultureInfo.InvariantCulture),
            " (",
            FormatOffset(local.Offset),
            ")");
    }

    /// <summary>
    /// <c>UTC+2</c>, <c>UTC-5:30</c>, <c>UTC</c>. Minutes appear only when they are not zero:
    /// most of the world runs on whole hours and "(UTC+2:00)" is noise on a page a client skims.
    /// Not localised — this is a technical notation and reads the same in every language.
    /// </summary>
    private static string FormatOffset(TimeSpan offset)
    {
        if (offset == TimeSpan.Zero)
        {
            return "UTC";
        }

        var sign = offset < TimeSpan.Zero ? '-' : '+';
        var magnitude = offset.Duration();

        return magnitude.Minutes == 0
            ? string.Create(CultureInfo.InvariantCulture, $"UTC{sign}{magnitude.Hours}")
            : string.Create(
                CultureInfo.InvariantCulture,
                $"UTC{sign}{magnitude.Hours}:{magnitude.Minutes:00}");
    }

    /// <summary>A quantity as one string, with the unit left exactly as it was spoken.</summary>
    public string FormatQuantity(ReportQuantity quantity)
    {
        var value = quantity.Value?.ToString("0.###", NumberCulture);

        return (value, quantity.Unit) switch
        {
            (null, null) => string.Empty,
            (null, var unit) => unit!,
            (var number, null) => number!,
            var (number, unit) => $"{number} {unit}",
        };
    }

    /// <summary>A culture that may not exist on a minimal container, without taking the report
    /// down over a decimal comma.</summary>
    private static CultureInfo Culture(string name)
    {
        try
        {
            return CultureInfo.GetCultureInfo(name);
        }
        catch (CultureNotFoundException)
        {
            return CultureInfo.InvariantCulture;
        }
    }

    public static ReportStrings Serbian { get; } = new()
    {
        Language = "sr",
        NumberCulture = Culture("sr-Latn-RS"),
        DatePattern = "dd.MM.yyyy.",
        TimestampPattern = "dd.MM.yyyy. HH:mm",

        DocumentTitle = "Dnevni izveštaj",
        Contractor = "Izvođač",
        Site = "Gradilište",
        Date = "Datum",

        WorkDone = "Izvedeni radovi",
        Workforce = "Radna snaga",
        Materials = "Materijal",
        HiddenWork = "Skriveni radovi",
        Blockers = "Zastoji i smetnje",
        Notes = "Napomene",
        Photos = "Fotografije",

        Location = "Lokacija",
        Quantity = "Količina",
        Delivered = "Isporučeno",
        Yes = "da",
        No = "ne",
        WaitingOn = "čeka se",
        WorkersOnSite = "Ukupno na gradilištu",
        NothingRecorded = "nije evidentirano",

        HiddenWorkNote =
            "Radovi koji se zatvaraju i kasnije se ne mogu utvrditi bez razgradnje.",

        VerbatimDescription = "Opis dana",
        VerbatimNote =
            "Dan je opisan glasovnom porukom sa gradilišta. Tekst koji sledi je doslovan prepis "
            + "te poruke — nije razvrstan u stavke radova, materijala i radne snage.",

        CorrectionHeading = "Ispravka",
        CorrectionOfSentReport =
            "Ovaj izveštaj ispravlja i zamenjuje dnevni izveštaj za {0}, koji Vam je poslat {1}. "
            + "Podaci u ovom dokumentu su ispravni i zamenjuju podatke iz tog izveštaja.",
        // The date is followed by a comma rather than a full stop, and that is not a detail: the
        // Serbian pattern already ends in one (02.09.2026.), so "za {0}." renders as "za
        // 02.09.2026.." — two dots on a client's document. Found by reading a rendered PDF rather
        // than by reading the template, exactly as the email's missing period was.
        CorrectionOfUnsentRecord =
            "Ovaj izveštaj ispravlja i zamenjuje raniji zapis za {0}, koji Vam nije poslat.",
        Corrects = "Ispravlja zapis za",

        RecordKind = "Vrsta zapisa",
        RecordKindVerbatim = "doslovan prepis glasovne poruke sa terena",

        RecordSection = "Podaci o zapisu",
        CapturedAt = "Snimljeno na terenu",
        ReceivedAt = "Primljeno na server",
        Checksum = "SHA-256",
        GeneratedAt = "Izveštaj generisan",
        EvidenceNote =
            "Fotografije su preuzete iz originalnog zapisa. Kontrolni zbir svake fotografije "
            + "proveren je prema vrednosti koju je telefon prijavio pri snimanju, pre unosa u "
            + "ovaj izveštaj.",

        PageOf = "Strana {0} / {1}",
        PhotoCaption = "Fotografija {0}",

        EmailSubject = "Dnevni izveštaj — {0} — {1}",
        EmailGreeting = "Poštovani,",
        // No sentence-final period: the Serbian date already ends in one (29.08.2026.), and a
        // second one reads as a typo in the first line a client sees. Found by reading a real
        // message out of the local catcher rather than by reading the template.
        EmailBody = "u prilogu Vam dostavljamo dnevni izveštaj sa gradilišta {0} za {1}",
        EmailClosing = "S poštovanjem,",
        EmailAutomatedNote =
            "Izveštaj je generisan automatski iz zapisa sa terena. Molimo ne odgovarajte na ovu "
            + "poruku.",

        AttachmentNameStem = "Dnevni-izvestaj-{0}",
    };

    public static ReportStrings English { get; } = new()
    {
        Language = "en",
        NumberCulture = Culture("en-GB"),
        DatePattern = "dd/MM/yyyy",
        TimestampPattern = "dd/MM/yyyy HH:mm",

        DocumentTitle = "Daily site report",
        Contractor = "Contractor",
        Site = "Site",
        Date = "Date",

        WorkDone = "Work carried out",
        Workforce = "Workforce",
        Materials = "Materials",
        HiddenWork = "Work to be covered",
        Blockers = "Delays and obstructions",
        Notes = "Notes",
        Photos = "Photographs",

        Location = "Location",
        Quantity = "Quantity",
        Delivered = "Delivered",
        Yes = "yes",
        No = "no",
        WaitingOn = "waiting on",
        WorkersOnSite = "Total on site",
        NothingRecorded = "none recorded",

        HiddenWorkNote =
            "Work that is about to be closed up and cannot be inspected afterwards without "
            + "demolition.",

        VerbatimDescription = "The day as described",
        VerbatimNote =
            "The day was described in a voice note recorded on site. The text below is a verbatim "
            + "transcript of that recording — it has not been broken down into work, material and "
            + "workforce items.",

        CorrectionHeading = "Correction",
        CorrectionOfSentReport =
            "This report corrects and replaces the daily report for {0}, which was sent to you on "
            + "{1}. The details in this document are the correct ones and supersede that report.",
        CorrectionOfUnsentRecord =
            "This report corrects and replaces an earlier record for {0}. That record was never "
            + "sent to you.",
        Corrects = "Corrects the record for",

        RecordKind = "Record type",
        RecordKindVerbatim = "verbatim transcript of a voice note from site",

        RecordSection = "Record details",
        CapturedAt = "Captured on site",
        ReceivedAt = "Received by the server",
        Checksum = "SHA-256",
        GeneratedAt = "Report generated",
        EvidenceNote =
            "The photographs come from the original record. Each one's checksum was verified "
            + "against the value the capturing phone reported before it was placed in this "
            + "report.",

        PageOf = "Page {0} / {1}",
        PhotoCaption = "Photograph {0}",

        EmailSubject = "Daily site report — {0} — {1}",
        EmailGreeting = "Dear Sir or Madam,",
        EmailBody = "please find attached the daily site report for {0}, {1}.",
        EmailClosing = "Kind regards,",
        EmailAutomatedNote =
            "This report was generated automatically from a site record. Please do not reply to "
            + "this message.",

        AttachmentNameStem = "Daily-site-report-{0}",
    };
}
