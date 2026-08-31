using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// Admin passwords (profile-and-identity §5). A pure function over the BCL, so this needs neither
/// a database nor a host.
/// <para>
/// The two properties worth stating: the cost factor is <b>pinned</b>, because "600 000 iterations"
/// is a decision rather than a default and a silent drop to 1 000 would leave every hash in the
/// product weaker with nothing failing; and <see cref="PasswordHash.Verify"/> is <b>total</b> over
/// its stored argument, because this runs on a login path and a row written by some future version
/// must not become a 500 that announces the format changed.
/// </para>
/// </summary>
public sealed class PasswordHashTests
{
    private const string Password = "vodoinstal-petrović-2026";

    [Fact]
    public void A_password_verifies_against_its_own_hash() =>
        PasswordHash.Verify(Password, PasswordHash.Hash(Password)).ShouldBeTrue();

    [Theory]
    [InlineData("vodoinstal-petrović-2027")]
    [InlineData("vodoinstal-petrovic-2026")]   // one diacritic away
    [InlineData("Vodoinstal-petrović-2026")]   // case matters
    [InlineData("")]
    public void A_different_password_does_not(string other) =>
        PasswordHash.Verify(other, PasswordHash.Hash(Password)).ShouldBeFalse();

    [Fact]
    public void The_same_password_hashes_differently_every_time()
    {
        // Salted. Two identical passwords in the users table must not be visibly identical.
        var first = PasswordHash.Hash(Password);
        var second = PasswordHash.Hash(Password);

        first.ShouldNotBe(second);
        PasswordHash.Verify(Password, first).ShouldBeTrue();
        PasswordHash.Verify(Password, second).ShouldBeTrue();
    }

    [Fact]
    public void The_stored_form_names_its_algorithm_and_cost()
    {
        // Versioned on purpose: moving to Argon2id later is "rehash on next successful login",
        // not a migration and not a forced reset for every customer.
        var stored = PasswordHash.Hash(Password);
        var parts = stored.Split('$');

        parts.Length.ShouldBe(4);
        parts[0].ShouldBe("pbkdf2-sha256");
        parts[1].ShouldBe("600000");
        parts[2].ShouldNotBeEmpty();
        parts[3].ShouldNotBeEmpty();
    }

    [Fact]
    public void The_cost_factor_is_pinned()
    {
        // The number ships as a decision (OWASP 2023 for PBKDF2-HMAC-SHA256) and is to be
        // re-measured on the real VPS at B3a. Changing it should be a deliberate act that turns
        // this line red, never a quiet edit that makes every future hash cheaper to attack.
        PasswordHash.Iterations.ShouldBe(600_000);
        PasswordHash.Algorithm.ShouldBe("pbkdf2-sha256");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-hash")]
    [InlineData("pbkdf2-sha256$600000$onlythreefields")]
    [InlineData("pbkdf2-sha256$600000$!!!notbase64!!!$!!!notbase64!!!")]
    [InlineData("pbkdf2-sha256$0$c2FsdA==$aGFzaA==")]
    [InlineData("pbkdf2-sha256$notanumber$c2FsdA==$aGFzaA==")]
    [InlineData("argon2id$3$c2FsdA==$aGFzaA==")]
    [InlineData("$$$")]
    public void A_stored_value_it_cannot_read_is_false_rather_than_an_exception(string? stored) =>
        PasswordHash.Verify(Password, stored).ShouldBeFalse();

    [Fact]
    public void A_user_who_has_never_set_a_password_cannot_be_logged_in_as()
    {
        // password_hash is NULL until an admin completes his invite — and NULL forever for a
        // worker (ck_app_user_worker_has_no_password). Neither may be satisfied by any input,
        // including an empty one.
        PasswordHash.Verify(Password, null).ShouldBeFalse();
        PasswordHash.Verify("", null).ShouldBeFalse();
        PasswordHash.Verify(null, null).ShouldBeFalse();
    }

    [Fact]
    public void A_hash_written_at_a_different_cost_still_verifies()
    {
        // The point of storing the iteration count rather than assuming it: raising the constant
        // must not lock out every account hashed under the old one. Built by hand at a low cost
        // so the test stays fast.
        const string knownPassword = "test";
        var stored = ManualHash(knownPassword, iterations: 1_000);

        PasswordHash.Verify(knownPassword, stored).ShouldBeTrue();
        PasswordHash.Verify("wrong", stored).ShouldBeFalse();
    }

    [Fact]
    public void An_unknown_account_still_costs_a_verify()
    {
        // Not a timing assertion — those are flaky by nature. It asserts the seam exists and is
        // callable, so the D2 login handler has something to call on the "no such email" branch
        // instead of returning in microseconds and turning login into an enumeration oracle.
        Should.NotThrow(() => PasswordHash.DummyVerify("anything"));
        Should.NotThrow(() => PasswordHash.DummyVerify(null));
    }

    private static string ManualHash(string password, int iterations)
    {
        var salt = new byte[16];
        Random.Shared.NextBytes(salt);
        var derived = System.Security.Cryptography.Rfc2898DeriveBytes.Pbkdf2(
            password, salt, iterations,
            System.Security.Cryptography.HashAlgorithmName.SHA256, 32);

        return string.Join(
            '$',
            PasswordHash.Algorithm,
            iterations,
            Convert.ToBase64String(salt),
            Convert.ToBase64String(derived));
    }
}
