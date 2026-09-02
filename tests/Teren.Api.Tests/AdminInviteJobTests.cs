using Microsoft.EntityFrameworkCore;
using Shouldly;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;

namespace Teren.Api.Tests;

/// <summary>
/// The invite mail, where its behaviour actually lives.
///
/// <para>
/// <b>These assertions used to be about a response body.</b> Until 2026-09-01 the platform routes
/// handed the plaintext set-password token back so staff could read the link down the phone; the
/// founder removed that, and the token is now minted inside <c>AdminInviteJob</c> and reaches
/// exactly one address. So the mint, the supersede and the copy are tested here — through the
/// message a person would actually receive, which is a stronger question than the one the old
/// tests asked.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class AdminInviteJobTests(TerenTestApp app) : ApiTestBase(app)
{
    private async Task<AppUser> GivenAdminAsync(
        string email, string language = "sr", bool withPassword = false)
    {
        await using var identity = App.CreateIdentityDbContext();

        var user = new AppUser
        {
            Id = Guid.NewGuid(),
            CompanyId = TestIds.CompanyA,
            Role = AppUserRole.CompanyAdmin,
            DisplayName = "Nikola Nikolić",
            Email = email,
            Language = language,
            PasswordHash = withPassword ? PasswordHash.Hash("an-old-passphrase-here") : null,
            CreatedAt = DateTime.UtcNow,
        };

        identity.Users.Add(user);
        await identity.SaveChangesAsync(Ct);
        return user;
    }

    [Fact]
    public async Task Sends_him_a_link_that_carries_a_live_single_use_token()
    {
        var admin = await GivenAdminAsync("nikola@gradnja.rs");

        var mail = await App.RunInviteJobAsync(admin.Id, admin.Id, Ct);

        mail.ShouldNotBeNull();
        mail!.ToAddress.ShouldBe("nikola@gradnja.rs");
        mail.ToName.ShouldBe("Nikola Nikolić");

        // The URL points at the app, not at the API: a set-password token is followed in a
        // browser, and a link to the wrong origin is a link that 404s in a customer's hands.
        InviteMail.LinkIn(mail.TextBody).ShouldStartWith("https://app.teren.test/set-password?token=");
        InviteMail.TokenIn(mail.HtmlBody).ShouldBe(InviteMail.TokenIn(mail.TextBody));

        await using var identity = App.CreateIdentityDbContext();
        var token = await identity.PasswordTokens.SingleAsync(t => t.UserId == admin.Id, Ct);
        token.Purpose.ShouldBe(PasswordTokenPurpose.Invite);
        token.ConsumedAt.ShouldBeNull();
        token.SupersededAt.ShouldBeNull();
        // The row keeps the hash and nothing else — the plaintext lived in the job and the mail.
        token.TokenHash.ShouldNotContain("trn_p_");
    }

    /// <summary>
    /// Nothing in the database compels the supersede — there is no <c>ux_password_token_live</c> —
    /// so sending again must retire the link it replaces. Otherwise a founder who re-sends because
    /// "the first one never arrived" leaves it valid for another 48 hours, in whatever inbox it did
    /// in fact arrive in.
    /// </summary>
    [Fact]
    public async Task Sending_again_retires_the_link_it_replaces()
    {
        var admin = await GivenAdminAsync("drugi@gradnja.rs");
        var sender = new CapturingMailSender();

        await App.RunInviteJobAsync(admin.Id, admin.Id, Ct, sender);
        await App.RunInviteJobAsync(admin.Id, admin.Id, Ct, sender);

        sender.Sent.Count.ShouldBe(2);
        var first = InviteMail.TokenIn(sender.Sent[0].TextBody);
        var second = InviteMail.TokenIn(sender.Sent[1].TextBody);
        first.ShouldNotBe(second);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.CountAsync(
            t => t.UserId == admin.Id && t.ConsumedAt == null && t.SupersededAt == null, Ct))
            .ShouldBe(1);
        (await identity.PasswordTokens.CountAsync(
            t => t.UserId == admin.Id && t.SupersededAt != null, Ct))
            .ShouldBe(1);
    }

    /// <summary>
    /// <b>An invite speaks the recipient's language; a report speaks the project's.</b> They are
    /// different people and the rule is not shared — the client reads the report, the admin reads
    /// this. Asserted in both, because a dictionary that resolved one and fell through on the other
    /// would be invisible until a customer received it.
    /// </summary>
    [Fact]
    public async Task Speaks_the_language_the_recipient_chose()
    {
        var serbian = await GivenAdminAsync("srpski@gradnja.rs");
        var english = await GivenAdminAsync("english@gradnja.rs", language: "en");

        var sr = await App.RunInviteJobAsync(serbian.Id, serbian.Id, Ct);
        var en = await App.RunInviteJobAsync(english.Id, english.Id, Ct);

        sr!.TextBody.ShouldContain("lozink");
        sr.Subject.ShouldContain("nalog");

        en!.TextBody.ShouldContain("password");
        en.Subject.ShouldContain("account");
    }

    /// <summary>
    /// A reset, not an invite, when the account already has a password — derived from the row
    /// rather than requested, because it is a fact about the account and a parameter would only be
    /// a way to record it wrongly. It is also the forensic signal for the §13.6 risk: staff minting
    /// a link for an account that already had a password is the shape of the dangerous act.
    /// </summary>
    [Fact]
    public async Task Is_a_reset_when_he_already_had_a_password()
    {
        var admin = await GivenAdminAsync("stari@gradnja.rs", withPassword: true);

        await App.RunInviteJobAsync(admin.Id, admin.Id, Ct);

        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.SingleAsync(t => t.UserId == admin.Id, Ct))
            .Purpose.ShouldBe(PasswordTokenPurpose.Reset);
    }

    /// <summary>
    /// <b>No relay means no token.</b> Minting one for a mail nobody sends would leave a live
    /// credential in the database that no human will ever be told about — and, worse, it would
    /// supersede a link that had already reached somebody.
    /// </summary>
    [Fact]
    public async Task Mints_nothing_when_there_is_no_relay()
    {
        var admin = await GivenAdminAsync("bezrelej@gradnja.rs");
        var silent = new CapturingMailSender(configured: false);

        await App.RunInviteJobAsync(admin.Id, admin.Id, Ct, silent);

        silent.Sent.ShouldBeEmpty();
        await using var identity = App.CreateIdentityDbContext();
        (await identity.PasswordTokens.CountAsync(t => t.UserId == admin.Id, Ct)).ShouldBe(0);
    }

    /// <summary>
    /// With no <c>Auth:AppUrl</c> there is no address to send anyone to, so the job says so rather
    /// than mailing a bare token nobody can use. The token it minted is left to expire; that is
    /// deliberately not cleaned up, because a 48-hour unusable row is a smaller problem than a
    /// second write path over credentials.
    /// </summary>
    [Fact]
    public async Task Sends_nothing_when_there_is_nowhere_to_send_him()
    {
        var admin = await GivenAdminAsync("bezurl@gradnja.rs");
        var sender = new CapturingMailSender();

        await App.RunInviteJobAsync(admin.Id, admin.Id, Ct, sender, appUrl: string.Empty);

        sender.Sent.ShouldBeEmpty();
    }

    /// <summary>
    /// A foreman can never hold a password — <c>ck_app_user_worker_has_no_password</c> makes the
    /// hash unstorable — so a link for one could only ever fail a CHECK. His way back is a fresh
    /// activation code.
    /// </summary>
    [Fact]
    public async Task Refuses_a_foreman_and_an_account_that_is_not_there()
    {
        var sender = new CapturingMailSender();

        await App.RunInviteJobAsync(TestIds.WorkerA, TestIds.WorkerA, Ct, sender);
        await App.RunInviteJobAsync(Guid.NewGuid(), TestIds.SuperAdmin, Ct, sender);

        sender.Sent.ShouldBeEmpty();
    }

    /// <summary>
    /// The message carries a credential, so it carries it once and to one place.
    ///
    /// <para>
    /// Written because the whole point of this increment was to stop a set-password token
    /// travelling through a response body, a screen and a chat message. A mail with a second
    /// recipient, or a subject line with the token in it, would put it straight back on the loose.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Puts_the_credential_in_the_body_and_nowhere_else()
    {
        var admin = await GivenAdminAsync("jedan@gradnja.rs");

        var mail = await App.RunInviteJobAsync(admin.Id, admin.Id, Ct);

        var token = InviteMail.TokenIn(mail!.TextBody);
        mail.Subject.ShouldNotContain(token);
        mail.ToAddress.ShouldBe("jedan@gradnja.rs");
    }

    /// <summary>
    /// The link's lifetime is <c>Auth:PasswordTokenLifetime</c> and not a literal.
    ///
    /// <para>
    /// It was <c>TimeSpan.FromHours(48)</c> in this job until 2026-09-02, on a class that was
    /// already injecting <c>IOptions&lt;AuthOptions&gt;</c> for <c>AppUrl</c>. That option is
    /// validated, pinned by a test, and is what <c>/auth/password</c>, <c>invite-admin</c> and the
    /// platform route all measure a token against — so on a host that shortened it, the emailed
    /// link lived longer than the setting said and the mail's own "valid for N hours" sentence was
    /// printed from the literal rather than from the truth. One answer to "how long is a link good
    /// for".
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_link_lives_exactly_as_long_as_the_configured_lifetime()
    {
        var admin = await GivenAdminAsync("rok@gradnja.rs");
        var lifetime = TimeSpan.FromHours(3);

        var before = DateTime.UtcNow;
        var mail = await App.RunInviteJobAsync(
            admin.Id, admin.Id, Ct, passwordTokenLifetime: lifetime);

        await using var identity = App.CreateIdentityDbContext();
        var token = await identity.PasswordTokens.SingleAsync(t => t.UserId == admin.Id, Ct);

        token.ExpiresAt.ShouldBeGreaterThanOrEqualTo(before.Add(lifetime).AddSeconds(-5));
        token.ExpiresAt.ShouldBeLessThanOrEqualTo(
            DateTime.UtcNow.Add(lifetime).AddSeconds(5),
            "the row's expiry came from the literal 48 hours rather than from the option");

        // And the sentence the recipient reads agrees with the row he was given.
        mail!.TextBody.ShouldContain("3");
        mail.TextBody.ShouldNotContain("48");
        mail.HtmlBody.ShouldNotContain("48");
    }
}
