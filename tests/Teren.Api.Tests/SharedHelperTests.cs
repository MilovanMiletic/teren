using Microsoft.EntityFrameworkCore;
using Npgsql;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Mail;
using Teren.Core.Reporting;
using Teren.Core.Text;
using Teren.Core.Time;
using Teren.Api.Tests.Infrastructure;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Tests;

/// <summary>
/// The four helpers that were written more than once, now written once.
///
/// <para>
/// <b>Duplication is a maintenance complaint until one copy drifts, and one of these four had.</b>
/// Three places resolved a stored language tag by trimming, lower-casing and accepting <c>en</c>,
/// <c>en-us</c> or <c>en-gb</c>; the fourth — the admin invite email — compared
/// <c>OrdinalIgnoreCase</c> against <c>"en"</c> alone. So one account could have got an English
/// report, an English activation message and a <b>Serbian</b> invitation to set his password:
/// the one of the three a person receives before he has ever seen the product. That is the
/// divergence this file exists to keep from coming back.
/// </para>
///
/// <para>
/// The other three — the Postgres unique-violation check, the UTC stamp, and the audit-row builder
/// — are pinned because each of them has a wrong-looking-right version that compiles.
/// </para>
/// </summary>
public sealed class SharedHelperTests
{
    // ------------------------------------------------------------------------------- language

    [Theory]
    [InlineData("en")]
    [InlineData("EN")]
    [InlineData(" en ")]
    [InlineData("en-us")]
    [InlineData("en-US")]
    [InlineData("en-GB")]
    public void The_three_readers_of_a_language_tag_now_agree_that_it_is_english(string tag)
    {
        // Before the reconciliation, `AdminInviteStrings.For` answered Serbian to four of these
        // six while the other two readers answered English.
        LanguageTag.IsEnglish(tag).ShouldBeTrue(tag);

        ReportStrings.For(tag).ShouldBe(ReportStrings.English, tag);
        WorkerInviteStrings.For(tag).ShouldBe(WorkerInviteStrings.English, tag);
        AdminInviteStrings.For(tag).ShouldBe(AdminInviteStrings.English, tag);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("sr")]
    [InlineData("SR")]
    [InlineData("sr-Latn-RS")]
    [InlineData("english")]
    [InlineData("de")]
    public void Anything_else_is_serbian_in_all_three(string? tag)
    {
        // Serbian is the default rather than a fallback: the users are Serbian tradesmen and their
        // bosses, and a tag nobody can parse must not stop a report, an invite or a code going out.
        LanguageTag.IsEnglish(tag).ShouldBeFalse(tag ?? "null");

        ReportStrings.For(tag).ShouldBe(ReportStrings.Serbian);
        WorkerInviteStrings.For(tag).ShouldBe(WorkerInviteStrings.Serbian);
        AdminInviteStrings.For(tag).ShouldBe(AdminInviteStrings.Serbian);
    }

    [Fact]
    public void A_stored_language_is_narrowed_to_one_of_the_two_the_product_ships()
    {
        // What `WorkerEndpoints.LanguageOf` writes to app_user.language. It used to accept `en`
        // alone while every reader of the column accepted `en-GB` too — so what was stored and
        // what was understood could disagree about the same word.
        LanguageTag.Of("en-GB").ShouldBe("en");
        LanguageTag.Of("EN").ShouldBe("en");
        LanguageTag.Of("de").ShouldBe("sr");
        LanguageTag.Of(null).ShouldBe("sr");

        LanguageTag.Serbian.ShouldBe(ReportStrings.DefaultLanguage);
        LanguageTag.Serbian.ShouldBe(AdminInviteStrings.DefaultLanguage);
        LanguageTag.Serbian.ShouldBe(WorkerInviteStrings.DefaultLanguage);
    }

    [Fact]
    public void The_two_invite_vocabularies_are_no_longer_both_called_InviteStrings()
    {
        // They are different words for different people at different moments — the worker's
        // activation code, and the admin's set-password link — and having one name in two
        // namespaces is how a `using` decides which copy of a rule you get.
        typeof(WorkerInviteStrings).FullName.ShouldBe("Teren.Core.Identity.WorkerInviteStrings");
        typeof(AdminInviteStrings).FullName.ShouldBe("Teren.Core.Mail.AdminInviteStrings");

        // And they really are different vocabularies, not one type twice.
        WorkerInviteStrings.Serbian.MailSubject.ShouldNotBe(AdminInviteStrings.Serbian.Subject);
    }

    // ------------------------------------------------------------------------- postgres errors

    [Fact]
    public void A_unique_violation_is_recognised_only_under_the_constraint_that_was_named()
    {
        // Four handlers had a private copy of this and one had the SQLSTATE as the bare literal
        // "23505". The constraint name is matched exactly and is never optional: a catch that
        // took "any unique violation" would turn a constraint added later into a confident,
        // specific and wrong 409.
        var violation = Violation("23505", "ux_app_user_email");

        PostgresErrors.IsUniqueViolation(violation, "ux_app_user_email").ShouldBeTrue();
        PostgresErrors.IsUniqueViolation(violation, "ux_app_user_username").ShouldBeFalse();

        // A different SQLSTATE under the same constraint name is not this failure.
        PostgresErrors
            .IsUniqueViolation(Violation("23503", "ux_app_user_email"), "ux_app_user_email")
            .ShouldBeFalse();

        // And an EF failure with nothing from Postgres underneath it is not one either.
        PostgresErrors
            .IsUniqueViolation(new DbUpdateException("no inner"), "ux_app_user_email")
            .ShouldBeFalse();

        PostgresErrors.IsUniqueViolation(null, "ux_app_user_email").ShouldBeFalse();
    }

    // ------------------------------------------------------------------------------ utc stamps

    [Fact]
    public void A_stored_timestamp_goes_out_carrying_its_offset()
    {
        // THE BUG THIS PREVENTS. Npgsql hands back Unspecified for a timestamptz column, and a
        // stamp serialised with no offset is read by every browser as LOCAL time — so a report
        // sent at 07:00 UTC shows as 09:00 in Belgrade, silently.
        var stored = new DateTime(2026, 9, 2, 7, 0, 0, DateTimeKind.Unspecified);

        var stamp = UtcStamp.Of(stored);

        stamp.Offset.ShouldBe(TimeSpan.Zero);
        stamp.UtcDateTime.ShouldBe(new DateTime(2026, 9, 2, 7, 0, 0, DateTimeKind.Utc));
        stamp.ToString("o", System.Globalization.CultureInfo.InvariantCulture)
            .ShouldEndWith("+00:00");

        UtcStamp.OrNull(null).ShouldBeNull();
        UtcStamp.OrNull(stored).ShouldBe(stamp);
    }

    // ------------------------------------------------------------------------------ audit rows

    [Fact]
    public void An_audit_row_always_gets_an_id_of_its_own()
    {
        // Six call sites used to spell out this initialiser. `Id` is client-generated, so a copy
        // written without `Guid.NewGuid()` inserts under Guid.Empty and the SECOND such row fails
        // — on a primary key, in whatever unrelated request happened to run next.
        var at = new DateTime(2026, 9, 2, 12, 0, 0, DateTimeKind.Utc);
        var actor = Guid.NewGuid();
        var subject = Guid.NewGuid();
        var company = Guid.NewGuid();

        var row = AdminAudit.For(actor, AdminAuditActions.WorkerCreated, "app_user", subject, company, at);

        row.Id.ShouldNotBe(Guid.Empty);
        row.ActorUserId.ShouldBe(actor);
        row.Action.ShouldBe(AdminAuditActions.WorkerCreated);
        row.SubjectType.ShouldBe("app_user");
        row.SubjectId.ShouldBe(subject);
        row.CompanyId.ShouldBe(company);
        row.CreatedAt.ShouldBe(at);
        row.Detail.ShouldBeNull("an audit row carries no structure unless one was asked for");

        AdminAudit.For(actor, "x", "app_user", subject, company, at).Id
            .ShouldNotBe(row.Id, "every row gets its own id");

        // A platform-level action belongs to no company, and the detail is the one place structure
        // is allowed — ids, counts and outcomes, never customer content.
        var platform = AdminAudit.For(
            actor, AdminAuditActions.SuperAdminCreated, "app_user", actor, null, at,
            """{"source": "console"}""");

        platform.CompanyId.ShouldBeNull();
        platform.Detail.ShouldBe("""{"source": "console"}""");
    }

    [Fact]
    public void The_helpers_exist_exactly_once_in_the_tree()
    {
        // The point of the exercise, and the thing that quietly comes undone: somebody needs the
        // check in a new file, does not find it, and writes it again. Counting the definitions is
        // how "one place" stays a fact.
        var code = SourceTree.Files().ToDictionary(f => f, SourceTree.CodeOf);

        Definitions(code, "bool IsUniqueViolation(").ShouldBe(
            ["PostgresErrors.cs"],
            "the unique-violation check belongs to PostgresErrors and nowhere else");

        Definitions(code, "DateTimeOffset Of(DateTime ").ShouldBe(["UtcStamp.cs"]);
        Definitions(code, "DateTimeOffset? OrNull(DateTime? ").ShouldBe(["UtcStamp.cs"]);

        // And the conversion written out longhand, which is how it got copied eleven times in the
        // first place: it is three tokens and looks like nothing worth naming, right up until one
        // copy is missing the SpecifyKind and a browser reads a UTC stamp as local time. It now
        // appears NOWHERE — `UtcStamp.Of` writes the target-typed `new(...)`, so even the one true
        // implementation does not match this string.
        Definitions(code, "new DateTimeOffset(DateTime.SpecifyKind(").ShouldBeEmpty(
            "the UTC conversion belongs to UtcStamp.Of / UtcStamp.OrNull and nowhere else");
        Definitions(code, "AdminAudit For(").ShouldBe(["AdminAudit.cs"]);
        Definitions(code, "bool IsEnglish(").ShouldBe(["LanguageTag.cs"]);

        // Nothing constructs an audit row by hand any more; every one goes through the factory,
        // which is what makes the id impossible to forget. Matched on the object initialiser, not
        // on the type name — `new AdminAuditConfiguration()` is EF wiring and belongs here.
        code.Where(pair => System.Text.RegularExpressions.Regex.IsMatch(
                pair.Value, @"\bnew AdminAudit\s*(\{|\r?\n\s*\{)"))
            .Select(pair => Path.GetFileName(pair.Key))
            .ShouldBeEmpty();

        // And the raw SQLSTATE literal is gone: it was in one of the four copies, spelled out
        // rather than named, which is exactly the kind of difference four copies hide.
        code.Where(pair => pair.Value.Contains("\"23505\"", StringComparison.Ordinal))
            .Select(pair => Path.GetFileName(pair.Key))
            .ShouldBeEmpty("the SQLSTATE is PostgresErrorCodes.UniqueViolation, spelled once");
    }

    // ---------------------------------------------------------------------------------- helpers

    private static List<string> Definitions(
        Dictionary<string, string> code, string signature) =>
        [.. code
            .Where(pair => pair.Value.Contains(signature, StringComparison.Ordinal))
            .Select(pair => Path.GetFileName(pair.Key))
            .Order(StringComparer.Ordinal)];

    /// <summary>
    /// An EF failure shaped exactly as Npgsql delivers one: the <see cref="PostgresException"/> is
    /// the inner exception, and the SQLSTATE and constraint name are read off it.
    /// </summary>
    private static DbUpdateException Violation(string sqlState, string constraintName) =>
        new(
            "insert refused",
            new PostgresException(
                messageText: "duplicate key value violates unique constraint",
                severity: "ERROR",
                invariantSeverity: "ERROR",
                sqlState: sqlState,
                constraintName: constraintName));
}
