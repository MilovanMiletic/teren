using Teren.Api.Auth;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// The small pure pieces the identity surface is built out of: how a username is proposed and
/// judged, what counts as an email address, what a password has to be, and the lifetimes every one
/// of those credentials gets.
/// <para>
/// These need no database and no host, which is the point: they are the parts a handler test would
/// only exercise by accident, and each of them is a decision somebody could quietly change.
/// </para>
/// </summary>
public sealed class IdentityFormatTests
{
    // ------------------------------------------------------------ usernames

    [Theory]
    [InlineData("Zoran Jovanović", "zoran.jovanovic")]
    [InlineData("Miloš Đorđević", "milos.djordjevic")]
    // Cyrillic goes through the same transliteration the transcript pipeline uses.
    [InlineData("Зоран Јовановић", "zoran.jovanovic")]
    [InlineData("Saša Nikolić", "sasa.nikolic")]
    [InlineData("Nenad  Ilić ", "nenad.ilic")]
    [InlineData("Aleksandar Đ. Stanković", "aleksandar.dj.stankovic")]
    public void A_username_is_proposed_from_the_display_name(string displayName, string expected)
    {
        // Only the USERNAME is folded. The display name keeps its diacritics, and it is the
        // display name that appears on screen and in a report.
        UsernameFormat.Propose(displayName).ShouldBe(expected);
        UsernameFormat.IsValid(UsernameFormat.Propose(displayName)).ShouldBeTrue();
    }

    [Fact]
    public void A_proposal_that_survives_nothing_is_empty_rather_than_wrong()
    {
        // A name written in a script this does not handle produces nothing, and the caller asks
        // the admin to type one. A proposal is a convenience, never a requirement — and inventing
        // "user1234" would give a man an identity he cannot recognise as his own.
        UsernameFormat.Propose("こんにちは").ShouldBeEmpty();
        UsernameFormat.IsValid(UsernameFormat.Propose("こんにちは")).ShouldBeFalse();
    }

    [Theory]
    [InlineData("zoran.jovanovic")]
    [InlineData("zoran")]
    [InlineData("zoran-jovanovic")]
    [InlineData("zoran_j2")]
    [InlineData("a1b")]
    public void A_valid_username_is_accepted(string username) =>
        UsernameFormat.IsValid(username).ShouldBeTrue();

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("ab")]                  // shorter than the floor
    [InlineData("Zoran")]               // not normalised
    [InlineData(" zoran")]              // not trimmed
    [InlineData(".zoran")]              // leading separator
    [InlineData("zoran.")]              // trailing separator
    [InlineData("zoran..jovanovic")]    // doubled separator
    [InlineData("zoran jovanovic")]     // a space is not a separator here
    [InlineData("zoran@jovanovic")]
    [InlineData("зоран")]               // Cyrillic: this string is typed on unknown keyboards
    public void An_invalid_username_is_refused(string? username) =>
        UsernameFormat.IsValid(username).ShouldBeFalse();

    [Fact]
    public void The_next_free_username_counts_upwards_rather_than_randomising()
    {
        // Digits rather than a random suffix, because the admin reads this to the worker — and a
        // second Zoran Jovanović in one firm is the ordinary case this exists for.
        var taken = new HashSet<string>(["zoran.jovanovic", "zoran.jovanovic2"]);

        UsernameFormat.NextFree("zoran.jovanovic", taken.Contains).ShouldBe("zoran.jovanovic3");
        UsernameFormat.NextFree("nenad.ilic", taken.Contains).ShouldBe("nenad.ilic");
    }

    // ------------------------------------------------------------ email

    [Theory]
    [InlineData("  Petar@Primer.RS  ", "petar@primer.rs")]
    [InlineData("a@b.co", "a@b.co")]
    public void An_address_is_normalised_the_way_the_check_constraint_demands(
        string input, string expected)
    {
        // ck_app_user_email_normalised asserts email = lower(btrim(email)), so a value that
        // skipped this would be refused by the database rather than stored wrong.
        EmailAddress.TryNormalise(input, out var email).ShouldBeTrue();
        email.ShouldBe(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("petar")]
    [InlineData("petar@")]
    [InlineData("@primer.rs")]
    [InlineData("petar@primer")]        // no dot in the domain
    [InlineData("petar@@primer.rs")]
    [InlineData("petar @primer.rs")]
    [InlineData("petar@primer..rs")]
    public void A_malformed_address_is_refused(string? input) =>
        EmailAddress.TryNormalise(input, out _).ShouldBeFalse();

    // ------------------------------------------------------------ passwords

    [Fact]
    public void The_password_floor_is_twelve_characters_and_nothing_else()
    {
        // Pinned so that raising or lowering it is a decision rather than a drift. No composition
        // rules, deliberately: they are why people write Password1! on a sticky note, and this
        // product's real defence is 600 000 PBKDF2 iterations and an IP rate limiter.
        PasswordPolicy.MinimumLength.ShouldBe(12);

        PasswordPolicy.IsAcceptable("abcdefghijkl").ShouldBeTrue();
        PasswordPolicy.IsAcceptable("abcdefghijk").ShouldBeFalse();
        PasswordPolicy.IsAcceptable("            ").ShouldBeFalse();
        PasswordPolicy.IsAcceptable(null).ShouldBeFalse();
        PasswordPolicy.IsAcceptable(new string('x', PasswordPolicy.MaximumLength + 1))
            .ShouldBeFalse();
    }

    // ------------------------------------------------------------ lifetimes

    [Fact]
    public void The_shipped_credential_lifetimes_are_what_the_plan_says()
    {
        // Every value here is a security parameter. A lifetime that drifts is not a bug anybody
        // notices until a session that should have ended did not.
        var options = new AuthOptions();

        options.SessionLifetime.ShouldBe(TimeSpan.FromDays(30));
        options.SuperAdminSessionLifetime.ShouldBe(TimeSpan.FromHours(8));
        options.ActivationCodeLifetime.ShouldBe(TimeSpan.FromDays(7));
        options.PasswordTokenLifetime.ShouldBe(TimeSpan.FromHours(48));

        options.RateLimit.PermitLimit.ShouldBe(10);
        options.RateLimit.Window.ShouldBe(TimeSpan.FromMinutes(5));
    }

    [Fact]
    public void A_super_admins_session_is_shorter_because_of_what_it_can_reach()
    {
        var options = new AuthOptions();

        options.SessionLifetimeFor(AppUserRole.SuperAdmin)
            .ShouldBeLessThan(options.SessionLifetimeFor(AppUserRole.CompanyAdmin));

        // A worker never gets a session at all; the fallback is the ordinary one rather than a
        // surprise, so a future caller cannot get a 30-day super-admin session by accident.
        options.SessionLifetimeFor(AppUserRole.Worker).ShouldBe(options.SessionLifetime);
    }

    [Theory]
    [InlineData("SessionLifetime", 400)]
    [InlineData("SuperAdminSessionLifetime", 40)]
    [InlineData("ActivationCodeLifetime", 100)]
    [InlineData("PasswordTokenLifetime", 40)]
    public void An_absurd_lifetime_is_refused_at_start_up(string property, int days)
    {
        // ValidateOnStart, so a mistyped environment variable stops the host rather than issuing
        // a credential that outlives the customer.
        var options = new AuthOptions();
        typeof(AuthOptions).GetProperty(property)!
            .SetValue(options, TimeSpan.FromDays(days));

        options.Validate(new System.ComponentModel.DataAnnotations.ValidationContext(options))
            .ShouldNotBeEmpty();
    }

    [Fact]
    public void A_rate_limit_in_the_thousands_is_refused_because_it_is_not_a_limit()
    {
        var options = new AuthOptions { RateLimit = new AuthRateLimitOptions { PermitLimit = 5000 } };

        options.Validate(new System.ComponentModel.DataAnnotations.ValidationContext(options))
            .ShouldNotBeEmpty();
    }

    // ------------------------------------------------------------ audit vocabulary

    [Fact]
    public void Every_audit_verb_is_snake_case_and_distinct()
    {
        // "Who revoked this phone" has to be one query six months from now, not three spellings of
        // one word.
        var verbs = typeof(AdminAuditActions)
            .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToList();

        verbs.ShouldBeUnique();
        verbs.ShouldAllBe(v => v == v.ToLowerInvariant() && !v.Contains(' '));
        verbs.Count.ShouldBeGreaterThan(5);
    }
}
