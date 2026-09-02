using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Infrastructure.Seeding;

namespace Teren.Api.Tests;

/// <summary>
/// The worker's own "send me a code" path, where its behaviour actually lives.
///
/// <para>
/// <b>The one thing to read before changing any of this: minting is destructive.</b>
/// <c>ux_activation_code_live</c> allows a worker exactly one typeable code, so issuing a new one
/// supersedes whatever he is holding and nulls its plaintext. Until 2026-09-02 the
/// <em>unauthenticated</em> route did that inside the request and then sent nothing — a
/// <c>TODO(D6)</c> where the mail belonged, left standing after D6 shipped <c>IMailSender</c>. So
/// anyone who could guess a username could invalidate a foreman's code from a browser.
/// </para>
///
/// <para>
/// The mint now happens here, after every reason not to send. Which makes the important tests in
/// this file the ones that assert <b>nothing changed</b>.
/// </para>
/// </summary>
[Collection(TerenCollection.Name)]
public sealed class WorkerCodeMailJobTests(TerenTestApp app) : ApiTestBase(app)
{
    [Fact]
    public async Task With_a_relay_and_an_address_it_mints_a_new_code_and_mails_it()
    {
        await GivenEmailAsync("zoran@vodoinstal-petrovic.test");
        var previous = await GivenLiveCodeAsync();

        var mail = await App.RunWorkerCodeJobAsync(TestIds.WorkerA, Ct);

        mail.ShouldNotBeNull();
        mail!.ToAddress.ShouldBe("zoran@vodoinstal-petrovic.test");
        mail.ToName.ShouldBe("Zoran Jovanović");
        mail.Subject.ShouldBe(InviteStrings.Serbian.MailSubject);

        var codes = await LoadActivationCodesAsync(TestIds.WorkerA);
        codes.Count.ShouldBe(2);

        var live = codes.Single(c => c.SupersededAt is null && c.ConsumedAt is null);
        var retired = codes.Single(c => c.Id != live.Id);

        retired.SupersededAt.ShouldNotBeNull("ux_activation_code_live permits only one");
        // ck_activation_code_display_cleared refuses to let a dead code keep its plaintext.
        retired.CodeDisplay.ShouldBeNull();

        // The message carries the two things he types, and the new code — not the old one.
        mail.TextBody.ShouldContain(TestIds.WorkerAUsername);
        mail.TextBody.ShouldContain(live.CodeDisplay!);
        mail.TextBody.ShouldNotContain(ActivationCodeFormat.Format(previous));

        // The audit says he asked for it himself, which is what the column is for.
        (await LoadAuditAsync()).Select(a => a.Action)
            .ShouldContain(AdminAuditActions.ActivationCodeSelfRequested);

        // And it actually works, folded exactly as a man would type it.
        (await Activate(TestIds.WorkerAUsername, live.CodeDisplay!)).StatusCode
            .ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task With_no_relay_it_leaves_his_live_code_alone_and_sends_nothing()
    {
        // THE POINT OF THE WHOLE REDESIGN. A host with no relay is the ordinary case for most of
        // this product's life, and on such a host this request must be a no-op — not "mint and
        // hope". If the mint happened first, a stranger with a username could leave a foreman
        // holding a dead code and no way to get a live one until his boss noticed.
        await GivenEmailAsync("zoran@vodoinstal-petrovic.test");
        var live = await GivenLiveCodeAsync();

        var mail = await App.RunWorkerCodeJobAsync(
            TestIds.WorkerA, Ct, sender: new CapturingMailSender(configured: false));

        mail.ShouldBeNull();

        var codes = await LoadActivationCodesAsync(TestIds.WorkerA);
        codes.Count.ShouldBe(1, "nothing was minted, so nothing was superseded");
        codes[0].SupersededAt.ShouldBeNull();
        codes[0].CodeDisplay.ShouldNotBeNull();

        (await LoadAuditAsync()).Select(a => a.Action)
            .ShouldNotContain(AdminAuditActions.ActivationCodeSelfRequested);

        // The credential he is holding still activates a phone.
        (await Activate(TestIds.WorkerAUsername, ActivationCodeFormat.Format(live))).StatusCode
            .ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task With_no_address_on_file_it_leaves_his_live_code_alone_and_sends_nothing()
    {
        // The fixture's worker has no email. Decision 6 says that is normal, and a code nobody
        // can be sent is not worth destroying a usable one for.
        var live = await GivenLiveCodeAsync();

        (await App.RunWorkerCodeJobAsync(TestIds.WorkerA, Ct)).ShouldBeNull();

        (await LoadActivationCodesAsync(TestIds.WorkerA)).Count.ShouldBe(1);
        (await Activate(TestIds.WorkerAUsername, ActivationCodeFormat.Format(live))).StatusCode
            .ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_suspended_company_gets_nothing_and_loses_nothing()
    {
        // A suspended customer's men cannot activate phones (ActivateAsync refuses), so minting
        // and mailing a code into that company would be a credential nobody can use and a live
        // one destroyed to produce it.
        await GivenEmailAsync("zoran@vodoinstal-petrovic.test");
        var live = await GivenLiveCodeAsync();

        await using (var identity = App.CreateIdentityDbContext())
        {
            await identity.Companies
                .Where(c => c.Id == TestIds.CompanyA)
                .ExecuteUpdateAsync(u => u.SetProperty(c => c.SuspendedAt, DateTime.UtcNow), Ct);
        }

        (await App.RunWorkerCodeJobAsync(TestIds.WorkerA, Ct)).ShouldBeNull();

        var codes = await LoadActivationCodesAsync(TestIds.WorkerA);
        codes.Count.ShouldBe(1);
        codes[0].CodeDisplay.ShouldBe(ActivationCodeFormat.Format(live));
    }

    [Fact]
    public async Task An_unknown_user_id_is_an_ordinary_no_op()
    {
        // The route enqueues for EVERY request, including one carrying a username nobody has, so
        // that a stopwatch cannot tell the two apart. Guid.Empty is what it passes then, and it
        // must cost nothing and say nothing.
        await GivenEmailAsync("zoran@vodoinstal-petrovic.test");
        await GivenLiveCodeAsync();

        (await App.RunWorkerCodeJobAsync(Guid.Empty, Ct)).ShouldBeNull();
        (await App.RunWorkerCodeJobAsync(Guid.NewGuid(), Ct)).ShouldBeNull();

        (await LoadActivationCodesAsync(TestIds.WorkerA)).Count.ShouldBe(1);

        // The admin's own issue above wrote one audit row; the job wrote none.
        (await LoadAuditAsync()).Select(a => a.Action)
            .ShouldNotContain(AdminAuditActions.ActivationCodeSelfRequested);
    }

    [Fact]
    public async Task A_disabled_worker_gets_nothing()
    {
        await GivenEmailAsync("zoran@vodoinstal-petrovic.test");
        await GivenLiveCodeAsync();

        await using (var identity = App.CreateIdentityDbContext())
        {
            await identity.Users
                .Where(u => u.Id == TestIds.WorkerA)
                .ExecuteUpdateAsync(u => u.SetProperty(x => x.DisabledAt, DateTime.UtcNow), Ct);
        }

        (await App.RunWorkerCodeJobAsync(TestIds.WorkerA, Ct)).ShouldBeNull();

        (await LoadActivationCodesAsync(TestIds.WorkerA)).Count.ShouldBe(1);
    }

    [Fact]
    public async Task The_message_speaks_his_language_and_not_the_project_s()
    {
        // A report speaks the project's language because the client reads it; this speaks his,
        // because he does (ARCHITECTURE §7.1). Project A2 is English and has nothing to do with
        // it.
        await GivenEmailAsync("zoran@vodoinstal-petrovic.test");

        await using (var identity = App.CreateIdentityDbContext())
        {
            await identity.Users
                .Where(u => u.Id == TestIds.WorkerA)
                .ExecuteUpdateAsync(u => u.SetProperty(x => x.Language, "en"), Ct);
        }

        var mail = await App.RunWorkerCodeJobAsync(TestIds.WorkerA, Ct);

        mail.ShouldNotBeNull();
        mail!.Subject.ShouldBe(InviteStrings.English.MailSubject);
        mail.TextBody.ShouldContain(InviteStrings.English.CodeLabel);
        mail.TextBody.ShouldNotContain(InviteStrings.Serbian.CodeLabel);
    }

    [Fact]
    public async Task The_subject_line_never_carries_the_code()
    {
        // A subject shows on a locked screen and gets quoted into every reply in the thread.
        await GivenEmailAsync("zoran@vodoinstal-petrovic.test");

        var mail = await App.RunWorkerCodeJobAsync(TestIds.WorkerA, Ct);

        var code = (await LoadActivationCodesAsync(TestIds.WorkerA))
            .Single(c => c.SupersededAt is null).CodeDisplay!;

        mail!.Subject.ShouldNotContain(code);
        mail.TextBody.ShouldContain(code, Case.Sensitive, "the body is where it belongs");
    }

    // ------------------------------------------------------------ arrange

    private async Task GivenEmailAsync(string email)
    {
        await using var identity = App.CreateIdentityDbContext();
        await identity.Users
            .Where(u => u.Id == TestIds.WorkerA)
            .ExecuteUpdateAsync(u => u.SetProperty(x => x.Email, email), Ct);
    }

    /// <summary>A live code for the fixture's worker, issued through the real admin route, in its
    /// canonical (undashed) form.</summary>
    private async Task<string> GivenLiveCodeAsync()
    {
        await GivenCompanyAdminAsync();
        using var owner = await SignInAsync(TestIds.CompanyAdminAEmail);

        var response = await owner.PostNothing(
            $"/api/workers/{TestIds.WorkerA}/activation-code");
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.TextAsync());

        return ActivationCodeFormat.Fold((await response.JsonAsync()).GetText("code"));
    }

    private async Task<HttpResponseMessage> Activate(string username, string code)
    {
        using var anonymous = App.CreateAnonymousClient();

        return await anonymous.PostJson(
            "/auth/activate",
            new JsonObject
            {
                ["username"] = username,
                ["activation_code"] = code,
                ["device_name"] = "Zoranov telefon",
            });
    }
}
