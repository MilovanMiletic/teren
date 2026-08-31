using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// The code a foreman types once, with gloves, out of a WhatsApp message (profile-and-identity §5).
/// <para>
/// The folding rules are a <b>contract with the client half</b>, which arrives at F3: if the two
/// sides fold differently, a code works in one place and not the other, and the man standing on a
/// site has no way to tell which. Every rule below is therefore stated as a case rather than
/// described in prose.
/// </para>
/// </summary>
public sealed class ActivationCodeFormatTests
{
    [Fact]
    public void The_alphabet_is_crockfords_and_excludes_the_confusable_letters()
    {
        // I, L, O and U are absent by construction, not by luck — which is the reason for picking
        // a published alphabet over one invented this afternoon.
        ActivationCodeFormat.Alphabet.ShouldBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
        ActivationCodeFormat.Alphabet.Length.ShouldBe(32);

        foreach (var confusable in "ILOU")
        {
            ActivationCodeFormat.Alphabet.ShouldNotContain(confusable.ToString());
        }
    }

    [Fact]
    public void A_generated_code_is_eight_characters_of_that_alphabet()
    {
        for (var i = 0; i < 200; i++)
        {
            var code = ActivationCodeFormat.Generate();

            code.Length.ShouldBe(8);
            code.ShouldAllBe(c => ActivationCodeFormat.Alphabet.Contains(c));
        }
    }

    [Fact]
    public void Generated_codes_do_not_repeat_in_any_quantity_an_admin_would_ever_issue()
    {
        // 40 bits. Not a proof of entropy — a sanity check that Generate draws randomly rather
        // than returning something derived from a clock.
        var codes = Enumerable.Range(0, 1_000)
            .Select(_ => ActivationCodeFormat.Generate())
            .ToHashSet();

        codes.Count.ShouldBe(1_000);
    }

    [Fact]
    public void Generated_codes_avoid_the_profanity_blocklist()
    {
        // The admin reads this aloud to a customer.
        var codes = Enumerable.Range(0, 2_000)
            .Select(_ => ActivationCodeFormat.Generate())
            .ToList();

        codes.ShouldAllBe(c => !c.Contains("JEBE") && !c.Contains("FUCK") && !c.Contains("PZDA"));
    }

    [Fact]
    public void The_display_form_is_two_groups_of_four() =>
        ActivationCodeFormat.Format("XKD47HMP").ShouldBe("XKD4-7HMP");

    [Theory]
    // Crockford's four confusables, which is the whole reason folding exists.
    [InlineData("OOOOOOOO", "00000000")]
    [InlineData("IIIIIIII", "11111111")]
    [InlineData("LLLLLLLL", "11111111")]
    [InlineData("UUUUUUUU", "VVVVVVVV")]
    // Case.
    [InlineData("xkd47hmp", "XKD47HMP")]
    // Separators, spaces, and the shapes a paste actually arrives in.
    [InlineData("XKD4-7HMP", "XKD47HMP")]
    [InlineData("XKD4 7HMP", "XKD47HMP")]
    [InlineData("  xkd4 - 7hmp  ", "XKD47HMP")]
    [InlineData("XKD4​7HMP", "XKD47HMP")]  // zero-width space out of a chat message
    [InlineData("XKD4-7HMP \U0001F44D", "XKD47HMP")]  // a thumbs-up pasted along with it
    // Folds fine and then fails on length — TryParse is what rejects it, not Fold.
    [InlineData("kod: xkd4-7hmp", "K0DXKD47HMP")]
    public void Folding_matches_the_contract(string input, string expected) =>
        ActivationCodeFormat.Fold(input).ShouldBe(expected);

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("-- --")]
    public void Folding_is_total(string? input) =>
        ActivationCodeFormat.Fold(input).ShouldBe(string.Empty);

    [Fact]
    public void Folding_is_idempotent()
    {
        // Folding an already-folded code must not move it, or a client that folds before sending
        // and a server that folds on receipt would disagree about the same string.
        for (var i = 0; i < 200; i++)
        {
            var code = ActivationCodeFormat.Generate();
            var once = ActivationCodeFormat.Fold(ActivationCodeFormat.Format(code));

            once.ShouldBe(code);
            ActivationCodeFormat.Fold(once).ShouldBe(code);
        }
    }

    [Fact]
    public void A_code_survives_its_own_display_form()
    {
        for (var i = 0; i < 200; i++)
        {
            var code = ActivationCodeFormat.Generate();

            ActivationCodeFormat.TryParse(ActivationCodeFormat.Format(code), out var parsed)
                .ShouldBeTrue();
            parsed.ShouldBe(code);
        }
    }

    [Theory]
    [InlineData("xkd4-7hmp", "XKD47HMP")]
    [InlineData("XKD4 7HMP", "XKD47HMP")]
    [InlineData("oil47hmp", "01147HMP")]
    public void TryParse_returns_the_canonical_form_not_what_was_typed(
        string typed, string expected)
    {
        // The handler hashes the out parameter and never the caller's string, so a code typed
        // with an O cannot be hashed as an O and then fail to match.
        ActivationCodeFormat.TryParse(typed, out var code).ShouldBeTrue();
        code.ShouldBe(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("XKD47HM")]         // one short
    [InlineData("XKD47HMPQ")]       // one long
    [InlineData("kod: xkd4-7hmp")]  // folds to eleven characters
    public void TryParse_refuses_anything_that_is_not_a_code(string? typed)
    {
        ActivationCodeFormat.TryParse(typed, out var code).ShouldBeFalse();
        code.ShouldBe(string.Empty);
    }

    // ------------------------------------------------------------ the Cyrillic homoglyph table

    /// <summary>
    /// <b>The contract, restated as a test, because both halves must fold identically or a code
    /// will work in one place and not the other.</b> The client (F3) implements this exact list.
    /// Each pair is a Cyrillic letter drawn identically to its Latin twin; folding one must be
    /// indistinguishable from typing the other.
    /// </summary>
    [Theory]
    [InlineData('А', 'A')]   // А
    [InlineData('Е', 'E')]   // Е
    [InlineData('К', 'K')]   // К
    [InlineData('М', 'M')]   // М
    [InlineData('О', '0')]   // О → Latin O → Crockford 0
    [InlineData('Р', 'P')]   // Р
    [InlineData('С', 'C')]   // С
    [InlineData('Т', 'T')]   // Т
    [InlineData('У', 'Y')]   // У
    [InlineData('Х', 'X')]   // Х
    [InlineData('а', 'A')]   // а
    [InlineData('е', 'E')]   // е
    [InlineData('к', 'K')]   // к
    [InlineData('м', 'M')]   // м
    [InlineData('о', '0')]   // о
    [InlineData('р', 'P')]   // р
    [InlineData('с', 'C')]   // с
    [InlineData('т', 'T')]   // т
    [InlineData('у', 'Y')]   // у
    [InlineData('х', 'X')]   // х
    public void Cyrillic_homoglyphs_fold_to_their_latin_twins(char cyrillic, char expected) =>
        ActivationCodeFormat.Fold(cyrillic.ToString()).ShouldBe(expected.ToString());

    [Fact]
    public void A_code_typed_on_a_cyrillic_keyboard_still_parses()
    {
        // THE MUTATION TARGET. Before the table existed, Fold dropped every non-ASCII character as
        // "not a letter or a digit": this input came out five characters long, TryParse refused
        // it, and a foreman was told his code was wrong with nothing anywhere saying why.
        //
        // РАСТ4К5Х is Cyrillic Р А С Т 4 К 5 Х — visually identical to PACT4K5X.
        ActivationCodeFormat.TryParse("РАСТ" + "4" + "К5Х", out var code)
            .ShouldBeTrue();

        code.ShouldBe("PACT4K5X");
    }

    [Fact]
    public void Cyrillic_folding_happens_before_the_ascii_filter()
    {
        // Order is the whole design: fold first, then drop what is not ASCII. Reverse the two and
        // the table is dead code — every Cyrillic character is deleted before it can be mapped,
        // and this comes back empty.
        //
        // КОРТ is Cyrillic К О Р Т, drawn exactly like KOPT; Crockford then folds the O to a zero.
        ActivationCodeFormat.Fold("КОРТ").ShouldBe("K0PT");
    }

    [Theory]
    // Cyrillic В and Н are just as convincing as B and H, and both Latin targets are in the
    // alphabet — but they are DELIBERATELY NOT in the table, because widening it is a change to a
    // contract shared with the client and a one-sided widening is exactly the "works here, not
    // there" failure the table exists to prevent.
    [InlineData('В')]   // В
    [InlineData('Н')]   // Н
    // And a letter with no Latin twin at all.
    [InlineData('Ж')]   // Ж
    public void An_unmapped_cyrillic_letter_is_dropped_and_the_code_is_then_refused(char letter)
    {
        // Fails safe: dropping shortens the code, the length check refuses it outright, and the
        // man is asked to try again — rather than being quietly activated as somebody else.
        ActivationCodeFormat.Fold(letter.ToString()).ShouldBe(string.Empty);

        ActivationCodeFormat.TryParse("XKD47HM" + letter, out var code).ShouldBeFalse();
        code.ShouldBe(string.Empty);
    }

    [Fact]
    public void Folding_a_generated_code_is_still_a_no_op()
    {
        // The property the whole storage design rests on: code_hash is the hash of the canonical
        // form, and what a man types folds back to exactly that. The Crockford alphabet contains
        // no I, L, O or U and no Cyrillic, so a generated code is a fixed point of Fold.
        for (var i = 0; i < 200; i++)
        {
            var code = ActivationCodeFormat.Generate();
            ActivationCodeFormat.Fold(code).ShouldBe(code);
        }
    }
}
