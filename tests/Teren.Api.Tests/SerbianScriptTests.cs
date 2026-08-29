using Teren.Core.Text;

namespace Teren.Api.Tests;

/// <summary>
/// Cyrillic to Latin (ARCHITECTURE §14 decision 8). A pure function, so these are the only tests
/// in the suite that need neither a database nor a host — and the only place the digraphs
/// љ/њ/џ and the idempotence promise are actually checked.
/// </summary>
public sealed class SerbianScriptTests
{
    [Theory]
    // The whole lower-case alphabet, in order, so a single wrong row names itself.
    [InlineData("абвгдђежзијклљмнњопрстћуфхцчџш", "abvgdđežzijklljmnnjoprstćufhcčdžš")]
    [InlineData("АБВГДЂЕЖЗИЈКЛМНОПРСТЋУФХЦЧШ", "ABVGDĐEŽZIJKLMNOPRSTĆUFHCČŠ")]
    public void Maps_every_letter(string cyrillic, string latin) =>
        SerbianScript.ToLatin(cyrillic).ShouldBe(latin);

    [Theory]
    [InlineData("љубав", "ljubav")]
    [InlineData("њива", "njiva")]
    [InlineData("џак", "džak")]
    // Title case: the letter after the digraph is lower case, so only the first Latin letter is.
    [InlineData("Љубав", "Ljubav")]
    [InlineData("Њива", "Njiva")]
    [InlineData("Џак", "Džak")]
    // All caps: the letter after the digraph is upper case, so both Latin letters are.
    [InlineData("ЉУБАВ", "LJUBAV")]
    [InlineData("ЊИВА", "NJIVA")]
    [InlineData("ЏАК", "DŽAK")]
    public void Casing_of_a_digraph_follows_the_letter_after_it(string cyrillic, string latin) =>
        SerbianScript.ToLatin(cyrillic).ShouldBe(latin);

    [Fact]
    public void An_all_caps_word_ending_in_a_digraph_takes_the_title_case_form()
    {
        // Pinned, not endorsed. "КРАЉ" has nothing after the Љ to read the casing from, so the
        // rule ("look at the next letter") falls back to Lj and the word comes out KRALj rather
        // than KRALJ. That is a real wart, and it will show up in an all-caps client name on a
        // report one day. This test exists so the behaviour cannot drift silently in either
        // direction: changing it is a decision someone makes, with this line to change.
        SerbianScript.ToLatin("КРАЉ").ShouldBe("KRALj");

        // The same letter mid-word, with an upper-case letter after it, is unambiguous.
        SerbianScript.ToLatin("КРАЉЕВО").ShouldBe("KRALJEVO");
    }

    [Fact]
    public void Transliterates_a_real_transcript()
    {
        const string spoken =
            "Данас смо завршили развод топле и хладне воде од котла до купатила, 40 метара.";

        SerbianScript.ToLatin(spoken).ShouldBe(
            "Danas smo završili razvod tople i hladne vode od kotla do kupatila, 40 metara.");
    }

    [Fact]
    public void Is_idempotent_on_text_that_is_already_latin()
    {
        // The property the pipeline depends on: a re-run over a stored transcript must not
        // mangle it, and a foreman whose phone somehow sends Latin must not be double-converted.
        const string latin = "Ugradili smo 6 vodokotlića Geberit — čeka se štemovanje.";

        SerbianScript.ToLatin(latin).ShouldBe(latin);
        SerbianScript.ToLatin(SerbianScript.ToLatin(latin)).ShouldBe(latin);
    }

    [Fact]
    public void Converting_twice_is_the_same_as_converting_once()
    {
        var once = SerbianScript.ToLatin("Њиве и џакови, Љубав, ШЋЖ");
        SerbianScript.ToLatin(once).ShouldBe(once);
    }

    [Fact]
    public void Leaves_digits_punctuation_and_latin_alone()
    {
        // Azure normalises spoken numerals to digits, and material codes come back part-Latin.
        SerbianScript.ToLatin("PPR cev 25mm, 3/4\" — 40 m").ShouldBe("PPR cev 25mm, 3/4\" — 40 m");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Handles_empty_input(string input) =>
        SerbianScript.ToLatin(input).ShouldBe(input);

    [Fact]
    public void Handles_null() => SerbianScript.ToLatin(null).ShouldBe(string.Empty);

    [Fact]
    public void Detects_whether_there_is_anything_to_convert()
    {
        SerbianScript.ContainsCyrillic("Данас").ShouldBeTrue();
        SerbianScript.ContainsCyrillic("Danas").ShouldBeFalse();
        SerbianScript.ContainsCyrillic("PPR 25").ShouldBeFalse();
    }
}
