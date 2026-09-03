using System.Net;
using System.Text.Json.Nodes;
using Hangfire;
using Hangfire.Common;
using Hangfire.States;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Teren.Api.Jobs;
using Teren.Api.Tests.Infrastructure;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Mail;
using Teren.Core.Reporting;

namespace Teren.Api.Tests;

/// <summary>
/// <b>Teren staff cannot touch administrative access inside a customer's company quietly</b> —
/// <c>plans/profile-and-identity.md</c> §13.6, closed 2026-09-03.
///
/// <para>
/// <b>The finding.</b> <c>POST /api/platform/users</c> takes an <c>email</c> and a
/// <c>company_id</c> together, so a member of Teren's staff could create a brand-new
/// <c>company_admin</c> inside any customer's company with an address he controls, receive the
/// invite, set a password and read that customer's diaries. That is wider than the password reset
/// §13.6 was written about, and quieter: a reset locks the real administrator out — which is noise
/// a customer notices — while a second account disturbs nothing at all.
/// </para>
///
/// <para>
/// <b>The capability stays.</b> A customer's first administrator has to come from somewhere, and
/// "our only admin left the company" is a real support case. What is gone is being able to use it
/// without the customer being told, and these tests are what that sentence rests on:
/// </para>
/// <blockquote>
/// Teren staff cannot read a customer's diary with their own credentials. Minting or resetting an
/// administrator's credential in a customer's company is possible, is audited, and emails every
/// other administrator of that company — so it cannot be done without the customer being told.
/// </blockquote>
///
/// <para>
/// The Serbian and English copy is drafted by Claude and <b>owes the founder's review</b>: it is
/// customer-visible mail in his product's voice, and it arrives at a bad moment by definition.
/// </para>
/// </summary>
public sealed class AdminAccessNoticeJobTests(TerenTestApp app) : ApiTestBase(app)
{
    /// <summary>22:40 UTC is 00:40 the next day in Belgrade, so a notice printed in UTC names the
    /// wrong evening — on the one line a customer would use to reconcile this with what he
    /// knows.</summary>
    private static readonly DateTime OccurredAt = new(2026, 9, 2, 22, 40, 0, DateTimeKind.Utc);

    private static TimeZoneInfo Belgrade => ReportTimeZone.Resolve(ReportTimeZone.Default);

    private async Task<AppUser> GivenAdminAsync(
        string email,
        string displayName = "Nikola Nikolić",
        string language = "sr",
        Guid? companyId = null,
        bool disabled = false)
    {
        await using var identity = App.CreateIdentityDbContext();

        var user = new AppUser
        {
            Id = Guid.NewGuid(),
            CompanyId = companyId ?? TestIds.CompanyA,
            Role = AppUserRole.CompanyAdmin,
            DisplayName = displayName,
            Email = email,
            Language = language,
            PasswordHash = null,
            CreatedAt = DateTime.UtcNow,
            DisabledAt = disabled ? DateTime.UtcNow : null,
        };

        identity.Users.Add(user);
        await identity.SaveChangesAsync(Ct);
        return user;
    }

    // -------------------------------------------------------------------------- who is told

    [Fact]
    public async Task Every_other_active_administrator_of_the_company_is_told_and_nobody_else()
    {
        // The headline. Break the recipient query and this is what fails: staff add themselves to
        // a customer's company and the customer's own administrators never hear of it.
        var added = await GivenAdminAsync("staff@teren.rs", "Teren Staff");
        var owner = await GivenAdminAsync("vlasnik@gradnja.rs");
        var second = await GivenAdminAsync("drugi@gradnja.rs");

        // None of these may receive it: a disabled admin, an admin of another company, Teren's own
        // staff, and the company's own foreman (a worker is not an administrator).
        await GivenAdminAsync("otpusten@gradnja.rs", disabled: true);
        await GivenAdminAsync("tudji@druga.rs", companyId: TestIds.CompanyB);
        await GivenSuperAdminAsync("staff2@teren.rs");

        var sent = await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct);

        sent.Select(m => m.ToAddress).OrderBy(a => a, StringComparer.Ordinal).ShouldBe(
            new[] { second.Email!, owner.Email! }.OrderBy(a => a, StringComparer.Ordinal));
    }

    [Fact]
    public async Task The_man_the_notice_is_about_is_not_written_to()
    {
        // He is being told by the invite mail itself; a copy of the announcement would only tell
        // him what he already knows, and it is the *other* administrators this exists for.
        var added = await GivenAdminAsync("staff@teren.rs", "Teren Staff");
        await GivenAdminAsync("vlasnik@gradnja.rs");

        var sent = await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.CredentialIssued, OccurredAt, Ct);

        sent.ShouldHaveSingleItem().ToAddress.ShouldBe("vlasnik@gradnja.rs");
    }

    [Fact]
    public async Task A_company_with_no_other_administrator_is_told_nothing_and_that_is_the_limit()
    {
        // Written down rather than discovered: a brand-new customer whose first admin is being
        // created has nobody to tell, so only the audit row records it. This mail cannot close
        // that — there is no customer-side reader yet — which is why the product's sentence says
        // "every other administrator of that company" and must never soften into "the customer is
        // always told".
        var only = await GivenAdminAsync("prvi@gradnja.rs");

        var sent = await App.RunAccessNoticeJobAsync(
            only.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct);

        sent.ShouldBeEmpty();
    }

    [Fact]
    public async Task Nothing_is_sent_about_a_member_of_Terens_own_staff()
    {
        // A super admin has no company by construction (ck_app_user_company_scope), so there is no
        // customer to write to. Teren adding Teren staff is not a customer's business.
        var staff = await GivenSuperAdminAsync();
        await GivenAdminAsync("vlasnik@gradnja.rs");

        var sent = await App.RunAccessNoticeJobAsync(
            staff.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct);

        sent.ShouldBeEmpty();
    }

    [Fact]
    public async Task With_no_relay_nothing_is_sent_and_the_job_says_so()
    {
        var added = await GivenAdminAsync("staff@teren.rs");
        await GivenAdminAsync("vlasnik@gradnja.rs");

        var silent = new CapturingMailSender(configured: false);
        await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct, silent);

        silent.Sent.ShouldBeEmpty();
    }

    [Fact]
    public async Task One_refused_address_does_not_silence_the_rest()
    {
        // These people are being told something about their own company that only this message
        // tells them, and a relay that rejects one mailbox must not decide the others hear nothing.
        var added = await GivenAdminAsync("staff@teren.rs");
        var first = await GivenAdminAsync("prvi@gradnja.rs");
        var second = await GivenAdminAsync("drugi@gradnja.rs");

        var flaky = new FlakyMailSender(refuse: first.Email!);
        await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct, flaky);

        flaky.Attempted.Count.ShouldBe(2);
        flaky.Delivered.ShouldHaveSingleItem().ShouldBe(second.Email);
    }

    // ------------------------------------------------------------------------- what it says

    [Fact]
    public async Task It_names_the_account_the_company_and_the_time_so_an_admin_can_judge_it()
    {
        var added = await GivenAdminAsync("marko@teren.rs", "Marko Marković");
        await GivenAdminAsync("vlasnik@gradnja.rs");

        var mail = (await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct)).ShouldHaveSingleItem();

        // The address is the fact that answers "is this one of our people?" — without it the
        // notice is a rumour.
        mail.TextBody.ShouldContain("marko@teren.rs");
        mail.TextBody.ShouldContain("Marko Marković");
        mail.TextBody.ShouldContain(TestIds.CompanyAName);
        mail.Subject.ShouldContain(TestIds.CompanyAName);

        // The moment the access changed, in the market's own zone — 00:40 on the 3rd, not 22:40
        // on the 2nd.
        var s = ReportStrings.Serbian;
        mail.TextBody.ShouldContain(
            s.FormatTimestamp(new DateTimeOffset(OccurredAt, TimeSpan.Zero), Belgrade));
        mail.TextBody.ShouldNotContain(
            s.FormatTimestamp(new DateTimeOffset(OccurredAt, TimeSpan.Zero), TimeZoneInfo.Utc));
    }

    [Fact]
    public async Task It_carries_no_link_no_token_and_no_code_and_says_so()
    {
        // The notice must never become a delivery channel for a credential, and it must never
        // teach an administrator to expect one inside it — that would be the best phishing
        // template this product could ship.
        var added = await GivenAdminAsync("staff@teren.rs");
        await GivenAdminAsync("vlasnik@gradnja.rs");

        var mail = (await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.CredentialIssued, OccurredAt, Ct)).ShouldHaveSingleItem();

        foreach (var body in new[] { mail.TextBody, mail.HtmlBody })
        {
            body.ShouldNotContain("trn_", Case.Insensitive);
            body.ShouldNotContain("set-password", Case.Insensitive);
            body.ShouldNotContain("http", Case.Insensitive);
            body.ShouldNotContain("<a ", Case.Insensitive);
        }

        mail.TextBody.ShouldContain(AdminAccessNoticeStrings.Serbian.NoCredentialHere);
    }

    [Theory]
    [InlineData("sr")]
    [InlineData("en")]
    public async Task A_company_name_ending_in_d_o_o_does_not_print_two_full_stops(string language)
    {
        // Nearly every Serbian company name ends in `d.o.o.`, so a sentence that put the customer's
        // name at its end printed `d.o.o..` — which the first draft of this copy did, twice. It was
        // found by reading a rendered message rather than a template, exactly as the invite email's
        // duplicated period was, and this is what keeps the next copy edit from bringing it back.
        var added = await GivenAdminAsync("staff@teren.rs");
        await GivenAdminAsync("vlasnik@gradnja.rs", language: language);

        foreach (var kind in new[]
                 { AdminAccessNotice.AdministratorAdded, AdminAccessNotice.CredentialIssued })
        {
            var mail = (await App.RunAccessNoticeJobAsync(added.Id, kind, OccurredAt, Ct))
                .ShouldHaveSingleItem();

            mail.TextBody.Contains("..", StringComparison.Ordinal).ShouldBeFalse(
                $"{language} / {kind}\n\n" + mail.TextBody);
            mail.Subject.Contains("..", StringComparison.Ordinal).ShouldBeFalse(mail.Subject);
        }
    }

    [Fact]
    public async Task The_two_kinds_of_change_are_not_one_sentence()
    {
        // "An account was added" and "somebody can now set the password on an existing account"
        // are different facts, and an administrator acts differently on each.
        var added = await GivenAdminAsync("staff@teren.rs");
        await GivenAdminAsync("vlasnik@gradnja.rs");

        var creation = (await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct)).ShouldHaveSingleItem();
        var credential = (await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.CredentialIssued, OccurredAt, Ct)).ShouldHaveSingleItem();

        creation.Subject.ShouldNotBe(credential.Subject);
        creation.TextBody.ShouldNotBe(credential.TextBody);
    }

    [Fact]
    public async Task Each_administrator_is_written_to_in_his_own_language()
    {
        // The company row carries no language, and the recipients are the company's own people —
        // so "the company's language" is each administrator's own, by the one rule the whole
        // product uses.
        var added = await GivenAdminAsync("staff@teren.rs");
        var serbian = await GivenAdminAsync("srpski@gradnja.rs");
        var english = await GivenAdminAsync("english@gradnja.rs", language: "en-GB");

        var sent = await App.RunAccessNoticeJobAsync(
            added.Id, AdminAccessNotice.AdministratorAdded, OccurredAt, Ct);

        var sr = sent.Single(m => m.ToAddress == serbian.Email);
        var en = sent.Single(m => m.ToAddress == english.Email);

        sr.TextBody.ShouldContain("administrator");
        sr.Subject.ShouldContain("Dodat");
        en.Subject.ShouldContain("administrator was added");
        en.TextBody.ShouldContain("Teren support");
    }

    /// <summary>A relay that refuses exactly one mailbox and accepts the rest.</summary>
    private sealed class FlakyMailSender(string refuse) : IMailSender
    {
        public List<string> Attempted { get; } = [];

        public List<string> Delivered { get; } = [];

        public bool IsConfigured => true;

        public Task SendAsync(Core.Mail.MailMessage message, CancellationToken ct)
        {
            Attempted.Add(message.ToAddress);

            if (string.Equals(message.ToAddress, refuse, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("550 no such mailbox");
            }

            Delivered.Add(message.ToAddress);
            return Task.CompletedTask;
        }
    }
}

/// <summary>
/// The other half: that a credential actually going out is what reaches the notice.
///
/// <para>
/// A perfect job nobody calls is the shape of every registry defect this repository has been bitten
/// by — a declared slug with no call site, a renamed route with no consumer. So the chain is pinned
/// at both seams: the platform routes hand the <em>kind</em> of notice to the invite, and the invite
/// job asks for it <b>after</b> the relay has taken the mail.
/// </para>
///
/// <para>
/// <b>Why the ask lives in the job and not in the request.</b> The first cut announced at the
/// request, when a job was queued. Every reason the job then has to decline — no address, no relay,
/// and above all <c>Auth:AppUrl</c> unset, which is a documented reachable state on a host with a
/// relay — would have told a customer's administrators that a credential had been issued when
/// nothing had left the building. A security notice that cries wolf is worse than no notice, so it
/// is asked for one line after the send.
/// </para>
/// </summary>
public sealed class AdminAccessNoticeWiringTests(TerenTestApp app) : ApiTestBase(app)
{
    private static JsonObject NewAdmin(Guid? companyId) => new()
    {
        ["role"] = companyId is null
            ? AppUserRoleNames.SuperAdmin
            : AppUserRoleNames.CompanyAdmin,
        ["display_name"] = "Novi Administrator",
        ["email"] = "novi@teren.rs",
        ["company_id"] = companyId?.ToString(),
    };

    [Fact]
    public async Task Adding_a_company_admin_hands_the_invite_an_administrator_added_notice()
    {
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson("/api/platform/users", NewAdmin(TestIds.CompanyA));

        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());
        var created = (await response.JsonAsync()).GetProperty("user").GetGuid("id");

        var invite = App.Invites.Invites.ShouldHaveSingleItem();
        invite.UserId.ShouldBe(created);
        invite.Notice.ShouldBe(AdminAccessNotice.AdministratorAdded);
    }

    [Fact]
    public async Task Re_inviting_an_administrator_hands_the_invite_a_credential_issued_notice()
    {
        var admin = await GivenCompanyAdminAsync();
        using var staff = await GivenSuperAdminClientAsync();

        (await staff.PostNothing($"/api/platform/users/{admin.Id}/invite"))
            .StatusCode.ShouldBe(HttpStatusCode.OK);

        var invite = App.Invites.Invites.ShouldHaveSingleItem();
        invite.UserId.ShouldBe(admin.Id);
        invite.Notice.ShouldBe(AdminAccessNotice.CredentialIssued);

        // …and the two are not the same notice, which is the point of carrying it.
        invite.Notice.ShouldNotBe(AdminAccessNotice.AdministratorAdded);
    }

    [Fact]
    public async Task With_no_relay_no_invite_is_queued_and_so_nothing_is_announced()
    {
        App.Mail.Configured = false;
        using var staff = await GivenSuperAdminClientAsync();

        var response = await staff.PostJson("/api/platform/users", NewAdmin(TestIds.CompanyA));

        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.TextAsync());
        (await response.JsonAsync()).GetProperty("emailed").GetBoolean().ShouldBeFalse();

        App.Invites.Invites.ShouldBeEmpty();
        App.Invites.Notices.ShouldBeEmpty(
            "the account exists with no way in, and the response says so");
    }

    [Fact]
    public async Task A_sent_invite_asks_for_the_notice_it_was_given()
    {
        var admin = await GivenCompanyAdminAsync();

        var before = DateTime.UtcNow;
        // The admin is his own actor here, as in AdminInviteJobTests: `admin_audit.actor_user_id`
        // is a real foreign key, and this test is about the notice rather than about who asked.
        var mail = await App.RunInviteJobAsync(
            admin.Id, admin.Id, Ct, notice: AdminAccessNotice.CredentialIssued);

        mail.ShouldNotBeNull("the arrange did not send an invite");

        var notice = App.Invites.Notices.ShouldHaveSingleItem();
        notice.SubjectUserId.ShouldBe(admin.Id);
        notice.Notice.ShouldBe(AdminAccessNotice.CredentialIssued);
        notice.OccurredAt.ShouldBeGreaterThanOrEqualTo(before);
    }

    [Fact]
    public async Task An_invite_that_never_reached_a_relay_announces_nothing()
    {
        // THE test this design exists for. `Auth:AppUrl` unset is a reachable state on a host that
        // has a relay — appsettings.Development.json documents it as one — and the job then refuses
        // to mail a bare token. Nothing was handed out, so nothing may be announced.
        var admin = await GivenCompanyAdminAsync();

        var mail = await App.RunInviteJobAsync(admin.Id, admin.Id, Ct, appUrl: string.Empty);

        mail.ShouldBeNull("nothing should have been sent with no app URL");
        App.Invites.Notices.ShouldBeEmpty(
            "announcing a credential that never left the building is crying wolf");
    }

    [Fact]
    public async Task An_invite_that_no_relay_could_take_announces_nothing()
    {
        var admin = await GivenCompanyAdminAsync();

        await App.RunInviteJobAsync(
            admin.Id, admin.Id, Ct, sender: new CapturingMailSender(configured: false));

        App.Invites.Notices.ShouldBeEmpty();
    }

    [Fact]
    public void Every_mail_job_can_be_activated_out_of_the_container()
    {
        // <b>The guard that walks the registry, because a green suite cannot see this one.</b>
        // Hangfire activates a job out of the container, and every test in this suite constructs
        // these jobs by hand — so a missing `AddScoped` shows up nowhere except as a failed job on
        // the founder's host, hours later, with the customer's administrators never told. That is
        // exactly what happened while this increment was being written: the new job was reachable
        // from the code and unresolvable from the container.
        var jobs = typeof(AdminInviteJob).Assembly
            .GetTypes()
            .Where(t => t.IsClass
                && !t.IsAbstract
                && t.Namespace == "Teren.Api.Jobs"
                && t.Name.EndsWith("Job", StringComparison.Ordinal))
            .ToList();

        jobs.Count.ShouldBeGreaterThanOrEqualTo(3, "the scan found no mail jobs to check");

        using var scope = App.Factory.Services.CreateScope();

        foreach (var job in jobs)
        {
            scope.ServiceProvider.GetService(job).ShouldNotBeNull(
                $"{job.Name} is not registered; Hangfire cannot activate it. Program.cs.");
        }
    }

    [Fact]
    public async Task An_invite_to_a_member_of_Terens_own_staff_announces_nothing()
    {
        // He belongs to no customer company, so there is nobody to write to — and the queue is not
        // filled with a job that could only no-op.
        var colleague = await GivenSuperAdminAsync();

        var mail = await App.RunInviteJobAsync(
            colleague.Id, colleague.Id, Ct, notice: AdminAccessNotice.AdministratorAdded);

        mail.ShouldNotBeNull("staff still get their own invite");
        App.Invites.Notices.ShouldBeEmpty();
    }
}

/// <summary>
/// <b>No credential may ever be a Hangfire argument</b>, proven against the shipped queue rather
/// than against a seam.
///
/// <para>
/// Hangfire serialises a job's arguments into its own storage and keeps them in job history, which
/// is why <c>AdminInviteJob</c> and <c>WorkerCodeMailJob</c> mint <em>inside</em> the job instead of
/// taking a token or a code. That discipline was a comment on three files; here it is a property
/// checked mechanically: <b>every argument of every mail job is an id, an enum, a timestamp or a
/// cancellation token, and never a string.</b> A credential in this product is always a string —
/// <c>trn_p_…</c>, <c>DEM0-TEST</c> — so a string argument is the shape of the mistake.
/// </para>
///
/// <para>
/// It goes through <c>HangfireInviteQueue</c> with a recording <c>IBackgroundJobClient</c> because
/// the queue interface is a seam, and a seam can swallow a lie: this is the code that runs on the
/// founder's host, and it is also where "the right job with the right arguments" is decided.
/// </para>
/// </summary>
public sealed class MailJobArgumentTests
{
    [Fact]
    public void Every_mail_job_the_product_queues_takes_no_string_argument()
    {
        var recorder = new RecordingJobClient();
        var queue = new HangfireInviteQueue(
            recorder, NullLogger<HangfireInviteQueue>.Instance);

        queue.EnqueueInvite(Guid.NewGuid(), Guid.NewGuid(), AdminAccessNotice.AdministratorAdded);
        queue.EnqueueWorkerCodeMail(Guid.NewGuid());
        queue.EnqueueAdminAccessNotice(
            Guid.NewGuid(), AdminAccessNotice.CredentialIssued, DateTime.UtcNow);

        recorder.Jobs.Count.ShouldBe(3, "every enqueue must actually create a job");

        var offenders = (
            from job in recorder.Jobs
            from parameter in job.Method.GetParameters()
            where parameter.ParameterType == typeof(string)
            select $"{job.Type.Name}.{job.Method.Name}({parameter.Name})").ToList();

        offenders.ShouldBeEmpty(
            "Hangfire keeps job arguments in its own storage and in job history, so a credential "
            + "must never be one. Mint inside the job — see AdminInviteJob — and pass an id.\n"
            + string.Join("\n", offenders));
    }

    [Fact]
    public void The_queue_creates_the_job_each_caller_thinks_it_does()
    {
        // Anti-vacuity for the assertion above, and the seam check the IJobQueueDepth fixture
        // taught: a queue that enqueued nothing, or enqueued the wrong job, would pass a
        // "no string arguments" test perfectly.
        var recorder = new RecordingJobClient();
        var queue = new HangfireInviteQueue(
            recorder, NullLogger<HangfireInviteQueue>.Instance);

        var user = Guid.NewGuid();
        var actor = Guid.NewGuid();
        var occurredAt = new DateTime(2026, 9, 2, 22, 40, 0, DateTimeKind.Utc);

        queue.EnqueueInvite(user, actor, AdminAccessNotice.AdministratorAdded);
        queue.EnqueueWorkerCodeMail(user);
        queue.EnqueueAdminAccessNotice(user, AdminAccessNotice.AdministratorAdded, occurredAt);

        recorder.Jobs[0].Type.ShouldBe(typeof(AdminInviteJob));
        recorder.Jobs[0].Args[0].ShouldBe(user);
        recorder.Jobs[0].Args[1].ShouldBe(actor);
        recorder.Jobs[0].Args[2].ShouldBe(AdminAccessNotice.AdministratorAdded);

        recorder.Jobs[1].Type.ShouldBe(typeof(WorkerCodeMailJob));
        recorder.Jobs[1].Args[0].ShouldBe(user);

        recorder.Jobs[2].Type.ShouldBe(typeof(AdminAccessNoticeJob));
        recorder.Jobs[2].Args[0].ShouldBe(user);
        recorder.Jobs[2].Args[1].ShouldBe(AdminAccessNotice.AdministratorAdded);
        recorder.Jobs[2].Args[2].ShouldBe(occurredAt);
    }

    /// <summary>Hangfire's client, recording what the extension methods built.</summary>
    private sealed class RecordingJobClient : IBackgroundJobClient
    {
        public List<Job> Jobs { get; } = [];

        public string Create(Job job, IState state)
        {
            Jobs.Add(job);
            return Guid.NewGuid().ToString();
        }

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
