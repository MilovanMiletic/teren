using System.Text.Json.Nodes;
using Teren.Core.Reporting;
using Teren.Infrastructure.Processing;
using Teren.Infrastructure.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// The parts of B6 that are pure functions over configuration and JSON: the stale-window
/// arithmetic, the structure reader, the language resolution and the attachment name. No
/// database and no host.
/// </summary>
public sealed class ReportingContractTests
{
    // ---------------------------------------------------------------- the numbers

    [Fact]
    public void The_report_stale_window_outlasts_the_worst_case_report_pass()
    {
        // The same obligation Pipeline:StaleProcessingAfter carries, recomputed from the shipped
        // defaults rather than restated in a comment. If anyone raises the SMTP timeout, the
        // render budget or the attempt count, or shortens this window, the contradiction surfaces
        // here — not in a client wondering where yesterday's report went.
        var reporting = new ReportingOptions();
        var pipeline = new PipelineOptions();

        var worstCase = reporting.WorstCasePass(pipeline);

        reporting.StaleAfter.ShouldBeGreaterThan(
            worstCase,
            $"a healthy report pass can take up to {worstCase}, and the sweeper must not mark "
            + "one that is still running as abandoned");
    }

    [Fact]
    public void The_worst_case_is_dominated_by_the_two_bounded_phases_and_nothing_else()
    {
        // The arithmetic itself, so a phase added without a bound is visible: everything before
        // the claim is capped by RenderBudget, and delivery is capped by attempts x the
        // conversation budget.
        var reporting = new ReportingOptions();
        var pipeline = new PipelineOptions();

        var floor = reporting.RenderBudget
                    + (reporting.Smtp.ConversationBudget * pipeline.MaxAttempts);

        reporting.WorstCasePass(pipeline).ShouldBeGreaterThanOrEqualTo(floor);
        reporting.WorstCasePass(pipeline).ShouldBeLessThan(floor + TimeSpan.FromMinutes(1));
    }

    [Fact]
    public void One_attempt_is_bounded_by_the_conversation_not_by_one_protocol_command()
    {
        // B6 review N1. Reporting:Smtp:Timeout is MailKit's *per protocol operation* timeout —
        // the greeting, AUTH, MAIL FROM, one RCPT TO per recipient, DATA and the content upload
        // each get it in full — so multiplying it by the attempt count described a healthy pass
        // rather than bounding any pass. ConversationBudget is the real ceiling (enforced with a
        // linked CTS in SmtpReportDelivery) and is what the worst case must be built from.
        var reporting = new ReportingOptions();

        reporting.Smtp.ConversationBudget.ShouldBeGreaterThan(
            reporting.Smtp.Timeout,
            "a conversation of many operations cannot be bounded by the timeout of one of them");

        var pipeline = new PipelineOptions();
        var worstCase = reporting.WorstCasePass(pipeline);

        worstCase.ShouldBeGreaterThanOrEqualTo(
            reporting.Smtp.ConversationBudget * pipeline.MaxAttempts,
            "every attempt can run to the full conversation budget");

        // And the point of the whole exercise: even at that genuine bound, a live pass is still
        // comfortably inside the window the sweeper uses to declare one abandoned. Falling out of
        // it lands in the `recorded != 1` branch — the relay has the message and the row cannot
        // say so.
        reporting.StaleAfter.ShouldBeGreaterThan(worstCase);
    }

    [Fact]
    public void An_unconfigured_relay_is_a_missing_host_or_a_missing_sender()
    {
        new ReportingOptions().IsConfigured.ShouldBeFalse();

        new ReportingOptions { FromAddress = "a@b.test" }.IsConfigured.ShouldBeFalse();

        new ReportingOptions { Smtp = { Host = "relay.test" } }.IsConfigured.ShouldBeFalse();

        new ReportingOptions
        {
            FromAddress = "a@b.test",
            Smtp = { Host = "relay.test" },
        }.IsConfigured.ShouldBeTrue();
    }

    // ---------------------------------------------------------------- language

    [Theory]
    [InlineData("sr", "sr")]
    [InlineData("SR", "sr")]
    [InlineData(" sr ", "sr")]
    [InlineData("en", "en")]
    [InlineData("en-GB", "en")]
    // Anything unrecognised falls back to the product's default rather than failing the report:
    // a mistyped column must not stop a client's diary arriving.
    [InlineData("de", "sr")]
    [InlineData("", "sr")]
    [InlineData(null, "sr")]
    public void The_report_language_resolves_to_serbian_unless_english_was_asked_for(
        string? language, string expected) =>
        ReportStrings.For(language).Language.ShouldBe(expected);

    [Fact]
    public void The_two_languages_share_no_chrome_by_accident()
    {
        // A copy-paste that left an English heading in the Serbian table would be invisible
        // until a client read it.
        ReportStrings.Serbian.DocumentTitle.ShouldNotBe(ReportStrings.English.DocumentTitle);
        ReportStrings.Serbian.WorkDone.ShouldNotBe(ReportStrings.English.WorkDone);
        ReportStrings.Serbian.HiddenWork.ShouldNotBe(ReportStrings.English.HiddenWork);
        ReportStrings.Serbian.EmailSubject.ShouldNotBe(ReportStrings.English.EmailSubject);
    }

    [Fact]
    public void Dates_are_formatted_by_an_explicit_pattern_not_by_the_hosts_culture()
    {
        // No month names anywhere, so the page cannot change shape with an ICU version or with
        // whatever locale the container happens to boot in.
        var date = new DateOnly(2026, 8, 29);

        ReportStrings.Serbian.FormatDate(date).ShouldBe("29.08.2026.");
        ReportStrings.English.FormatDate(date).ShouldBe("29/08/2026");
    }

    // ---------------------------------------------------------------- attachment name

    [Fact]
    public void The_attachment_carries_the_site_and_the_date_in_plain_ascii()
    {
        var name = ReportFileName.ForDaily(
            ReportStrings.Serbian,
            "Stambena zgrada Vojvode Stepe 212",
            new DateOnly(2026, 8, 29));

        name.ShouldBe("Dnevni-izvestaj-2026-08-29-stambena-zgrada-vojvode-stepe-212.pdf");
    }

    [Theory]
    [InlineData("Kuća Miloša Obrenovića 17", "kuca-milosa-obrenovica-17")]
    [InlineData("Đorđe & Žarko d.o.o.", "djordje-zarko-d-o-o")]
    [InlineData("Bulevar oslobođenja 84, Novi Sad", "bulevar-oslobodjenja-84-novi-sad")]
    [InlineData("   ", "")]
    [InlineData(null, "")]
    public void Serbian_diacritics_fold_the_way_a_serbian_reader_would_spell_them(
        string? name, string expected) =>
        ReportFileName.Slug(name).ShouldBe(expected);

    [Fact]
    public void A_site_with_an_unspellable_name_still_produces_a_usable_file_name()
    {
        ReportFileName.ForDaily(ReportStrings.English, "###", new DateOnly(2026, 8, 29))
            .ShouldBe("Daily-site-report-2026-08-29.pdf");
    }

    // ---------------------------------------------------------------- the structure reader

    [Fact]
    public void A_v1_structure_is_read_field_for_field()
    {
        var content = ReportContentReader.Read(
            """
            {"schema_version":1,
             "work_done":[{"description":"Razvod vode","location":"2. sprat",
                           "quantity":{"value":40,"unit":"m"}}],
             "headcount":{"total":3,"roles":[{"role":"vodoinstalater","count":3}]},
             "materials":[{"name":"PPR cev 25mm","quantity":{"value":40,"unit":"m"},"delivered":true}],
             "blockers":[{"description":"čeka se štemovanje","waiting_on":"električari"}],
             "hidden_work":[{"description":"cevi u zidu","media_ids":["11111111-1111-4111-8111-111111111111"]}],
             "notes":"Sutra nastavak."}
            """);

        content.IsEmpty.ShouldBeFalse();
        content.WorkDone.Single().Description.ShouldBe("Razvod vode");
        content.WorkDone.Single().Quantity.ShouldBe(new ReportQuantity(40, "m"));
        content.Headcount.ShouldNotBeNull().Total.ShouldBe(3);
        content.Materials.Single().Delivered.ShouldBe(true);
        content.Blockers.Single().WaitingOn.ShouldBe("električari");
        content.HiddenWork.Single().MediaIds.Count.ShouldBe(1);
        content.Notes.ShouldBe("Sutra nastavak.");
    }

    [Fact]
    public void A_model_that_answered_in_the_wrong_shape_costs_a_field_not_the_report()
    {
        // The JSON was written by a language model and then edited on a phone. A reader that
        // threw on an unexpected type would turn "the quantity came back as a string" into "the
        // client gets no report at all".
        var content = ReportContentReader.Read(
            """
            {"schema_version":1,
             "work_done":[{"description":"Razvod vode","quantity":"40 m"},
                          {"location":"bez opisa"},
                          "ovo nije objekat",
                          {"description":"Montaža kotla","quantity":6}],
             "headcount":{},
             "materials":[{"name":"PPR cev 25mm","delivered":"mozda"}],
             "blockers":"nije lista",
             "notes":"   "}
            """);

        // Two of the four work items survive: the one with no description and the one that is
        // not an object are dropped, the rest is kept.
        content.WorkDone.Count.ShouldBe(2);
        content.WorkDone[0].Quantity.ShouldBe(new ReportQuantity(null, "40 m"));
        content.WorkDone[1].Quantity.ShouldBe(new ReportQuantity(6, null));

        content.Headcount.ShouldBeNull("an empty headcount is not worth a line on the page");
        content.Materials.Single().Delivered.ShouldBeNull();
        content.Blockers.ShouldBeEmpty();
        content.Notes.ShouldBeNull("whitespace is the same as absent on a printed page");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    [InlineData("""{"schema_version":1}""")]
    [InlineData("""{"schema_version":1,"work_done":[],"materials":[],"notes":null}""")]
    public void Nothing_worth_printing_reads_as_empty(string? json) =>
        ReportContentReader.Read(json).IsEmpty.ShouldBeTrue();

    [Fact]
    public void A_single_note_is_enough_to_be_worth_a_report()
    {
        ReportContentReader.Read("""{"schema_version":1,"notes":"Kiša, stali smo u 11h."}""")
            .IsEmpty.ShouldBeFalse();
    }

    [Fact]
    public void Content_is_never_translated_only_carried()
    {
        // CLAUDE.md: only the UI chrome is localised. What was spoken goes on the page as it was
        // spoken, whichever language the report is in.
        var content = ReportContentReader.Read(
            """{"schema_version":1,"materials":[{"name":"PPR cev 25mm","quantity":{"value":40,"unit":"m"}}]}""");

        content.Materials.Single().Name.ShouldBe("PPR cev 25mm");
        ReportStrings.English.FormatQuantity(content.Materials.Single().Quantity!)
            .ShouldBe("40 m", "the unit is content, not chrome");
    }

    // ---------------------------------------------------------------- recipients

    [Fact]
    public void A_distribution_list_is_read_in_order_and_deduplicated()
    {
        var recipients = ProjectRecipients.Read(
            """
            [{"name":"Jelena Marković","email":"jelena@example.com","role":"investitor"},
             {"name":"Aleksandar","email":"aleksandar@example.com","role":"nadzorni organ"},
             {"name":"Jelena again","email":"JELENA@example.com"},
             {"name":"nobody"},
             "not an object"]
            """);

        recipients.Select(r => r.Email).ShouldBe(
            ["jelena@example.com", "aleksandar@example.com"]);
        recipients[0].Role.ShouldBe("investitor");
        recipients[1].Name.ShouldBe("Aleksandar");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("not json")]
    public void A_project_with_no_usable_list_reads_as_nobody(string? json) =>
        ProjectRecipients.Read(json).ShouldBeEmpty();

    // ---------------------------------------------------------------- the covering note

    [Fact]
    public void The_mail_body_escapes_whatever_someone_typed_into_a_project_name()
    {
        // A project name is a street address a person typed. It reaches an HTML mail body, so it
        // is escaped there — the one place in this feature where site data becomes markup.
        var html = ReportMailBody.Html(
            ReportStrings.Serbian,
            "Petrović <script>alert(1)</script> d.o.o.",
            "Gradilište & Co",
            new DateOnly(2026, 8, 29));

        html.ShouldNotContain("<script>");
        html.ShouldContain("&lt;script&gt;");
        html.ShouldContain("Gradili");
        html.ShouldContain("&amp; Co");
    }

    [Fact]
    public void The_mail_body_names_the_site_and_the_day_in_the_projects_language()
    {
        var date = new DateOnly(2026, 8, 29);

        var serbian = ReportMailBody.Text(
            ReportStrings.Serbian, "Vodoinstal Petrović d.o.o.", "Vojvode Stepe 212", date);
        var english = ReportMailBody.Text(
            ReportStrings.English, "Vodoinstal Petrović d.o.o.", "Vojvode Stepe 212", date);

        serbian.ShouldContain("Vojvode Stepe 212");
        serbian.ShouldContain("29.08.2026.");
        serbian.ShouldContain("Poštovani");
        // The Serbian date pattern ends in a period; a sentence-final one after it reads as a
        // typo in the first line a client sees.
        serbian.ShouldNotContain("29.08.2026..");

        english.ShouldContain("Vojvode Stepe 212");
        english.ShouldContain("29/08/2026");
        english.ShouldContain("Dear Sir or Madam");
    }

    [Fact]
    public void The_failure_vocabulary_is_codes_that_survive_a_reworded_message()
    {
        // The same contract ProcessingFailure has: a stable machine-readable code the UI can
        // translate into Serbian, then an English detail for whoever reads the logs.
        var reason = ReportFailure.Describe(
            ReportFailure.PhotoChecksumMismatch, "media 1 hashes to abc but was declared as def");

        ReportFailure.CodeOf(reason).ShouldBe("photo_checksum_mismatch");
        ReportFailure.CodeOf(null).ShouldBeEmpty();
        ReportFailure.CodeOf("no_colon_here").ShouldBe("no_colon_here");
    }

    [Fact]
    public void Confirmed_structure_json_from_the_api_reads_back_the_way_the_report_expects()
    {
        // The bridge between what /confirm stores and what the report reads — the same JsonObject
        // the endpoint tests post, run through the reader.
        var corrected = new JsonObject
        {
            ["schema_version"] = 1,
            ["work_done"] = new JsonArray(
                new JsonObject { ["description"] = "Razvod tople i hladne vode" }),
        };

        ReportContentReader.Read(corrected.ToJsonString())
            .WorkDone.Single().Description.ShouldBe("Razvod tople i hladne vode");
    }
}
