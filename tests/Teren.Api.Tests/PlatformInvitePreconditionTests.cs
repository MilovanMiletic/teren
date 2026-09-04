using Microsoft.EntityFrameworkCore;
using Shouldly;
using Teren.Api.Tests.Infrastructure;
using Teren.Api.Platform;
using Teren.Core.Entities;

namespace Teren.Api.Tests;

/// <summary>
/// What the platform screen is told about an invite, and whether the answer is one the job will
/// honour.
///
/// <para>
/// <b><c>emailed</c> exists to prevent exactly one thing: an administrator who believes a mail is
/// on its way, and a customer who waits for it.</b> It had two preconditions and checked one. A
/// relay is half of "there is somewhere to send him"; the other half is <c>Auth:AppUrl</c>,
/// because the invite mail has no content but a set-password link and <c>AdminInviteJob</c> will
/// not post a bare token nobody can use. That variable defaults to empty and, until 2026-09-04,
/// appeared in no compose file and no env template — so on the dev host as configured, with Resend
/// live, this returned <b>true</b>, the screen said <em>emailed</em>, and the job logged a warning
/// and sent nothing.
/// </para>
///
/// <para>
/// <b>Why these tests build the class instead of calling the route.</b> The two assertions that
/// matter cannot be made through <c>POST /api/platform/users/{id}/invite</c> on this host, and
/// believing otherwise is how the gap survived. The test host runs with
/// <c>Hangfire__Enabled=false</c>, so <c>emailed</c> is already false there for an unrelated
/// reason — a route-level <c>ShouldBeFalse()</c> passes whether the precondition is checked or
/// not, which is the "spec that cannot fail" this repository keeps rediscovering. And
/// <c>Auth:AppUrl</c> reaches the container through a singleton <c>IOptions</c> bound once at
/// start-up, so it cannot be emptied for one test. <see cref="TerenTestApp.CreatePlatformDirectory"/>
/// is the seam; the queue is the fixture's recorder, so "refused" and "queued, then declined" are
/// distinguishable.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class PlatformInvitePreconditionTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>
    /// The positive control, and it is not optional. Without it every assertion below could be
    /// satisfied by a directory that refuses all invites, or by an arrange that never produced an
    /// invitable account.
    /// </summary>
    [Fact]
    public async Task Says_emailed_and_queues_the_invite_when_a_relay_and_an_origin_both_exist()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        App.Mail.Configured = true;
        App.Invites.InviteSucceeds = true;

        await using var identity = App.CreateIdentityDbContext();
        var directory = App.CreatePlatformDirectory(identity);

        var result = await directory.InviteAsync(admin.Id, TestIds.SuperAdmin, Ct);

        result.ShouldNotBeNull();
        result!.Emailed.ShouldBeTrue();
        App.Invites.Invites.ShouldHaveSingleItem().UserId.ShouldBe(admin.Id);
    }

    /// <summary>
    /// <b>The test the fix was written for.</b> A relay is configured — everything an operator
    /// would look at says mail works — and there is no origin to build a link against. The screen
    /// must be told no.
    /// </summary>
    [Fact]
    public async Task Says_not_emailed_and_asks_for_nothing_when_there_is_no_app_url()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        App.Mail.Configured = true;
        App.Invites.InviteSucceeds = true;

        await using var identity = App.CreateIdentityDbContext();
        var directory = App.CreatePlatformDirectory(identity, appUrl: string.Empty);

        var result = await directory.InviteAsync(admin.Id, TestIds.SuperAdmin, Ct);

        result.ShouldNotBeNull();
        result!.Emailed.ShouldBeFalse(
            "the screen was told an invite is on its way to a host that has nowhere to send him. "
            + "An administrator then stops chasing it and a customer waits for a mail that was "
            + "never going to arrive.");

        App.Invites.Invites.ShouldBeEmpty(
            "the invite was queued anyway, so the refusal happens an hour later in a job log "
            + "nobody reads — and the job's own mint would have retired whatever live link this "
            + "account already had.");
    }

    /// <summary>
    /// Blank is not a URL. <c>CanLink</c> is <c>IsNullOrWhiteSpace</c> rather than
    /// <c>IsNullOrEmpty</c> because a stray space in an env file is a real way to configure this,
    /// and <c>"   ".TrimEnd('/') + "/set-password?token=…"</c> is a link shaped exactly like a
    /// working one.
    /// </summary>
    [Fact]
    public async Task Whitespace_is_not_an_origin()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        App.Mail.Configured = true;
        App.Invites.InviteSucceeds = true;

        await using var identity = App.CreateIdentityDbContext();
        var directory = App.CreatePlatformDirectory(identity, appUrl: "   ");

        (await directory.InviteAsync(admin.Id, TestIds.SuperAdmin, Ct))!.Emailed.ShouldBeFalse();
        App.Invites.Invites.ShouldBeEmpty();
    }

    /// <summary>
    /// The other half of the AND, kept here beside it. A relay is still a precondition, and a test
    /// that only ever varied the new one would let the old check be deleted in silence.
    /// </summary>
    [Fact]
    public async Task Says_not_emailed_and_asks_for_nothing_when_there_is_no_relay()
    {
        var admin = await GivenCompanyAdminAsync(withPassword: false);
        App.Invites.InviteSucceeds = true;

        await using var identity = App.CreateIdentityDbContext();
        var directory = App.CreatePlatformDirectory(
            identity, sender: new CapturingMailSender(configured: false));

        (await directory.InviteAsync(admin.Id, TestIds.SuperAdmin, Ct))!.Emailed.ShouldBeFalse();
        App.Invites.Invites.ShouldBeEmpty();
    }

    /// <summary>
    /// Creating an administrator goes through the same predicate, and it is the wider door
    /// (plan §13.6): the account is created either way, so the response is the only thing that can
    /// say whether anybody can get into it.
    ///
    /// <para>
    /// Asserted separately because <c>Invite()</c> is called from two places and a fix applied to
    /// one of them would leave this one claiming a send. The account must still exist — refusing
    /// the mail is not refusing the request.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Creating_an_administrator_with_no_app_url_creates_him_and_says_not_emailed()
    {
        // A real row: unlike the invite route, creating an administrator writes an admin_audit,
        // and `actor_user_id` is a genuine foreign key.
        var staff = await GivenSuperAdminAsync();
        App.Mail.Configured = true;
        App.Invites.InviteSucceeds = true;

        await using var identity = App.CreateIdentityDbContext();
        var directory = App.CreatePlatformDirectory(identity, appUrl: string.Empty);

        var created = await directory.CreateAdminAsync(
            AppUserRoleNames.CompanyAdmin,
            "Novi Administrator",
            "bezorigin@gradnja.rs",
            TestIds.CompanyA,
            "sr",
            staff.Id,
            Ct);

        created.Outcome.ShouldBe(PlatformDirectory.CreateAdminOutcome.Created);
        created.Created.ShouldNotBeNull();
        created.Created!.Emailed.ShouldBeFalse(
            "the account exists with no way into it and the screen said a link was sent");

        App.Invites.Invites.ShouldBeEmpty();

        await using var check = App.CreateIdentityDbContext();
        (await check.Users.AnyAsync(u => u.Email == "bezorigin@gradnja.rs", Ct)).ShouldBeTrue(
            "refusing the mail is not refusing the request");
    }
}
