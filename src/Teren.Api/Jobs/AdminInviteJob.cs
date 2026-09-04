using Hangfire;
using Microsoft.EntityFrameworkCore;
using Teren.Api.Auth;
using Teren.Api.Endpoints;
using Teren.Core.Entities;
using Teren.Core.Mail;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Jobs;

/// <summary>
/// Emails a company admin the link that lets him choose a password.
///
/// <para>
/// <b>The job mints the token; the request does not.</b> That is the one design decision in this
/// file and it is what keeps a live credential out of Hangfire's own database. A set-password
/// token is only ever plaintext for the instant it is created — the row stores a SHA-256 — so a
/// job that emailed a token minted by the request would have to take it as an argument, and
/// Hangfire serialises arguments into its storage and keeps them in job history. The plan refuses
/// exactly that trade for activation codes (§5) and the reasoning is identical here. Minting
/// inside the job means the plaintext exists in one process, for one method call, and reaches
/// nothing but the relay.
/// </para>
///
/// <para>
/// <b>What the founder therefore does not see — and there is no longer a second door.</b> When a
/// relay is configured, adding an administrator no longer puts a link on his screen: there is
/// nothing to put there, and the person is being emailed. <c>POST /api/platform/users/{id}/invite</c>
/// — the button on <c>/platform/user/:userId</c> — used to be §9's escape hatch and mint inline so
/// a founder could read a set-password URL down the phone; on 2026-09-01 the founder removed
/// exactly that (*"bad behavior, i don't like that"*), so it queues **this job** and returns no
/// token and no link (<c>PlatformDirectory.InviteAsync</c>). Nothing in the request path ever holds
/// the plaintext. The terminal-only bootstrap <c>invite-admin</c> is what remains for a host with
/// no relay, which is a real cost and is written down where it is paid.
/// </para>
///
/// <para>
/// <b><c>[AutomaticRetry(Attempts = 0)]</c>, like every other job in this product.</b> Hangfire's
/// default is ten tries over half an hour, and each one here would <i>mint a new token and
/// supersede the last</i> — so a flapping relay would send a man a stack of links of which only
/// the final one works. Failing once and visibly is the better answer: the founder re-issues from
/// the person page, which is a button he already has.
/// </para>
/// </summary>
[AutomaticRetry(Attempts = 0)]
public sealed class AdminInviteJob(
    TerenIdentityDbContext db,
    IMailSender mail,
    IInviteQueue notices,
    Microsoft.Extensions.Options.IOptions<AuthOptions> authOptions,
    Microsoft.Extensions.Logging.ILogger<AdminInviteJob> logger)
{
    /// <summary>
    /// How long the emailed link lives: <c>Auth:PasswordTokenLifetime</c>, and nothing else.
    /// <para>
    /// It was a hardcoded 48 hours until 2026-09-02, on a job that was already injecting
    /// <c>IOptions&lt;AuthOptions&gt;</c> for <c>AppUrl</c>. That option is validated, pinned by a
    /// test, and is what <c>/auth/password</c>, <c>invite-admin</c> and
    /// <c>PlatformDirectory.InviteAsync</c> all measure a token against — so a host that shortened
    /// it got links that lived longer than the setting said, and the email's own "valid for 48
    /// hours" sentence was printed from the literal rather than from the truth. One answer to "how
    /// long is a link good for".
    /// </para>
    /// </summary>
    private TimeSpan Lifetime => authOptions.Value.PasswordTokenLifetime;

    /// <param name="notice">
    /// Which change of access the company's other administrators are to be told about
    /// (<see cref="AdminAccessNoticeJob"/>, plan §13.6) — a new administrator, or a credential
    /// issued on an account that already existed.
    /// <para>
    /// <b>It is decided by the caller and not derived here.</b> The token's own purpose
    /// (<c>invite</c> / <c>reset</c>) cannot tell them apart: re-inviting an account that has never
    /// had a password mints an <c>invite</c> token and is <em>not</em> a new administrator, and a
    /// notice that said otherwise would be wrong about the one fact it exists to state.
    /// </para>
    /// </param>
    public async Task RunAsync(
        Guid userId, Guid actorUserId, AdminAccessNotice notice, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);

        if (user is null || user.Email is null || user.Role == AppUserRole.Worker)
        {
            // A worker can never have a password (ck_app_user_worker_has_no_password), and an
            // account deleted between the request and this job is not an error worth a retry.
            logger.LogWarning(
                "Invite mail skipped for {UserId}: no such account, no address, or a worker.",
                userId);
            return;
        }

        if (!mail.IsConfigured)
        {
            // Should not happen — the caller checks before enqueuing — but a relay can be
            // unconfigured between the two. Loud, and no token is minted for a mail nobody sends.
            logger.LogWarning(
                "Invite mail skipped for {UserId}: no relay is configured. Re-issue the link from "
                + "the person page and read it out instead.",
                userId);
            return;
        }

        // **Read once, and checked BEFORE anything is written.** Both halves of that sentence are
        // the fix of 2026-09-04. `IssueAsync` supersedes every live token for this user on its way
        // past, and this branch used to sit *after* it and after `SaveChangesAsync` — so a host
        // with a relay and no `Auth:AppUrl` (every deployed host: the variable was in no compose
        // file and no env template) answered "emailed" on the screen, sent nothing, and retired
        // the previous attempt's link each time somebody pressed send again. If a real link had
        // ever gone out, a later invite from a host that had lost the setting would silently
        // retire it, and the customer's administrator could never get in.
        //
        // The local is what makes "read once" true: `authOptions.Value` is re-read on every
        // access, so checking the property and later formatting it could see two different
        // values, and the one thing this method must not do is mint against a precondition that
        // was true a moment ago.
        var appUrl = authOptions.Value.AppUrl;

        if (!PasswordTokens.CanLink(appUrl))
        {
            // No address to send him to. Saying so beats mailing a bare token nobody can use —
            // and now beats it without spending his existing one to find out.
            logger.LogWarning(
                "Invite mail skipped for {UserId}: Auth:AppUrl is not configured, so there is no "
                + "link to send. Nothing was minted and no live link was retired.",
                userId);
            return;
        }

        var companyName = user.CompanyId is Guid companyId
            ? await db.Companies.Where(c => c.Id == companyId).Select(c => c.Name)
                .FirstOrDefaultAsync(ct)
            : null;

        var issued = await PasswordTokens.IssueAsync(
            db, user, actorUserId, "invite_mail", Lifetime, ct);
        await db.SaveChangesAsync(ct);

        // Cannot be null: `CanLink` above is the same predicate `LinkFor` applies, against the
        // same local. The throw is here so that if the two ever come apart, this job fails loudly
        // rather than mailing something shaped like a link.
        var link = PasswordTokens.LinkFor(appUrl, issued.Token)
            ?? throw new InvalidOperationException(
                "Auth:AppUrl passed PasswordTokens.CanLink and then produced no link.");

        // His language, not the company's and not the project's: a report speaks the project's
        // language because the client reads it; an invite speaks the recipient's, because he does.
        var strings = AdminInviteStrings.For(user.Language);
        var product = "Teren";
        var hours = ((int)Lifetime.TotalHours).ToString(System.Globalization.CultureInfo.InvariantCulture);

        await mail.SendAsync(
            new Core.Mail.MailMessage
            {
                ToAddress = user.Email,
                ToName = user.DisplayName,
                Subject = string.Format(System.Globalization.CultureInfo.InvariantCulture, strings.Subject, product),
                TextBody = InviteMailBody.Text(strings, companyName ?? product, link, hours),
                HtmlBody = InviteMailBody.Html(strings, companyName ?? product, link, hours),
            },
            ct);

        // The id and nothing else. Never the address, never the token, never the link.
        logger.LogInformation("Invite mail sent for {UserId}.", userId);

        // **Here, and deliberately not at the request.** A credential has now actually reached a
        // relay, which is the fact the company's other administrators are being told about; every
        // way this method can decline to send is above this line — no such account, a worker, no
        // relay, no `Auth:AppUrl` — and each of them would otherwise have announced a credential
        // that never left the building. A security notice that cries wolf is worse than none.
        //
        // Only for a company admin: Teren's own staff belong to no customer, and there is nobody
        // to write to. The notice job checks this again; this check is what keeps the queue from
        // filling with jobs that can only no-op.
        if (user.Role == AppUserRole.CompanyAdmin && user.CompanyId is not null)
        {
            notices.EnqueueAdminAccessNotice(user.Id, notice, DateTime.UtcNow);
        }
    }
}

/// <summary>
/// The two bodies. Separated from the job so the copy can be read, and asserted, without a relay.
/// </summary>
public static class InviteMailBody
{
    public static string Text(AdminInviteStrings s, string companyName, string link, string hours) =>
        string.Join(
            "\n\n",
            s.Greeting,
            string.Format(System.Globalization.CultureInfo.InvariantCulture, s.Lead, companyName),
            link,
            string.Format(System.Globalization.CultureInfo.InvariantCulture, s.Expiry, hours),
            s.Unexpected);

    public static string Html(AdminInviteStrings s, string companyName, string link, string hours) =>
        $"""
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a">
          <p>{Escape(s.Greeting)}</p>
          <p>{Escape(string.Format(System.Globalization.CultureInfo.InvariantCulture, s.Lead, companyName))}</p>
          <p><a href="{Escape(link)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#c2410c;color:#ffffff;text-decoration:none;font-weight:600">{Escape(s.Action)}</a></p>
          <p style="color:#57534e">{Escape(string.Format(System.Globalization.CultureInfo.InvariantCulture, s.Expiry, hours))}</p>
          <p style="color:#57534e">{Escape(s.Fallback)}<br><span style="word-break:break-all">{Escape(link)}</span></p>
          <p style="color:#57534e">{Escape(s.Unexpected)}</p>
        </div>
        """;

    /// <summary>A display name goes into this HTML, so it is escaped. Same rule the report body
    /// follows — a customer's own name is the one piece of caller text in the document.</summary>
    private static string Escape(string value) =>
        value.Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal);
}
