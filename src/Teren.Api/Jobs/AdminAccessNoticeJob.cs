using Hangfire;
using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Core.Mail;
using Teren.Core.Reporting;
using Teren.Core.Time;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Jobs;

/// <summary>
/// Tells a company's other administrators that Teren staff changed administrative access inside
/// their company — <c>plans/profile-and-identity.md</c> §13.6, closed 2026-09-03.
///
/// <para>
/// <b>What this closes.</b> Staff genuinely must be able to create a customer's first admin, and
/// "our only administrator left the company" is a real support case — so the capability stays.
/// What could not stay is using it <em>quietly</em>: <c>POST /api/platform/users</c> takes an
/// <c>email</c> and a <c>company_id</c>, so staff could mint a brand-new <c>company_admin</c>
/// inside any customer's company with an address they control, receive the invite, set a password
/// and read that company's diaries. That path is wider than the password reset §13.6 worried
/// about, and quieter: a reset locks the real administrator out, which is noise a customer
/// notices, while a second account disturbs nothing at all. This job is the noise.
/// </para>
///
/// <para>
/// <b>It carries no credential, in the mail or in its own arguments.</b> The mail is a statement
/// that something happened — no token, no link, and it says so, because a security notice that
/// taught people to expect a link inside it would be a phishing template. The arguments are an id,
/// an enum and a timestamp: Hangfire serialises arguments into its own storage and keeps them in
/// job history, which is why <see cref="AdminInviteJob"/> mints inside the job rather than taking a
/// token, and the same rule holds here with nothing to mint.
/// </para>
///
/// <para>
/// <b>The moment is an argument rather than <c>UtcNow</c> read here.</b> A notice that says when
/// access changed has to say when it <em>changed</em> — a queue that ran an hour late would
/// otherwise put a wrong hour in the one message whose whole job is letting a customer reconcile
/// an event with what he knows.
/// </para>
///
/// <para>
/// <b>The honest limit, stated rather than discovered.</b> This tells every <em>other active</em>
/// administrator of the company. A company that has none — a brand-new customer whose first admin
/// is being created — has nobody to tell, so nothing is sent and the <c>admin_audit</c> row is the
/// only record. That is not a hole this mail can close: there is no customer-side reader yet. It
/// does mean the product's sentence must stay exactly as written — "emails every other
/// administrator of that company" — and never soften into "the customer is always told".
/// </para>
///
/// <para>
/// <b><c>[AutomaticRetry(Attempts = 0)]</c>, like every job in this product.</b> A retry would put
/// a second copy of the same notice in front of administrators who already have it, and the
/// per-recipient failure below is where "one bad address must not silence the rest" is handled.
/// A failed job is visible in the log stream and on the health page.
/// </para>
/// </summary>
[AutomaticRetry(Attempts = 0)]
public sealed class AdminAccessNoticeJob(
    TerenIdentityDbContext db,
    IMailSender mail,
    ILogger<AdminAccessNoticeJob> logger)
{
    public async Task RunAsync(
        Guid subjectUserId,
        AdminAccessNotice notice,
        DateTime occurredAt,
        CancellationToken ct)
    {
        var subject = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == subjectUserId, ct);

        if (subject is null
            || subject.Role != AppUserRole.CompanyAdmin
            || subject.CompanyId is not Guid companyId)
        {
            // A member of Teren's own staff has no company and therefore no customer to notify,
            // and an account deleted between the request and this job is not worth a retry.
            logger.LogInformation(
                "Access notice skipped for {SubjectId}: no such account, or it belongs to no "
                + "customer company.",
                subjectUserId);
            return;
        }

        if (!mail.IsConfigured)
        {
            // The caller checks before enqueuing, so this is the relay disappearing in between.
            // Loud: an unsent notice is the difference between "audited and announced" and
            // "audited", which is the whole claim.
            logger.LogWarning(
                "Access notice NOT sent for {SubjectId}: no relay is configured, so the company's "
                + "other administrators have not been told.",
                subjectUserId);
            return;
        }

        var companyName = await db.Companies
            .Where(c => c.Id == companyId)
            .Select(c => c.Name)
            .FirstOrDefaultAsync(ct);

        // Every other administrator of this company who can still sign in and has somewhere to be
        // written to. A *pending* admin is included on purpose: he is an administrator of record
        // and the address is his, and "the account you were invited to has just been joined by
        // somebody else" is exactly the message that must not be withheld.
        var recipients = await db.Users.AsNoTracking()
            .Where(u => u.CompanyId == companyId
                && u.Role == AppUserRole.CompanyAdmin
                && u.Id != subjectUserId
                && u.DisabledAt == null
                && u.Email != null)
            .OrderBy(u => u.CreatedAt)
            .ToListAsync(ct);

        if (recipients.Count == 0)
        {
            logger.LogInformation(
                "Access notice for {SubjectId}: this company has no other active administrator to "
                + "tell, so only the audit trail records it.",
                subjectUserId);
            return;
        }

        // The market's zone. A notice has no project and a person carries no time zone, and an
        // hour printed wrong is a notice nobody can reconcile — same call as the worker's code mail.
        var zone = ReportTimeZone.Resolve(ReportTimeZone.Default);
        var moment = UtcStamp.Of(occurredAt);

        var told = 0;
        var failed = 0;

        foreach (var recipient in recipients)
        {
            var strings = AdminAccessNoticeStrings.For(recipient.Language);
            var text = strings.Notice(
                notice,
                companyName ?? string.Empty,
                subject.DisplayName,
                subject.Email ?? string.Empty,
                moment,
                zone);

            try
            {
                await mail.SendAsync(
                    new Core.Mail.MailMessage
                    {
                        ToAddress = recipient.Email!,
                        ToName = recipient.DisplayName,
                        Subject = strings.SubjectFor(notice, companyName ?? string.Empty),
                        TextBody = text,
                        HtmlBody = AdminAccessNoticeBody.Html(text),
                    },
                    ct);

                told++;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                // One refused address must not silence the rest: these people are being told
                // something about their own company that only this message tells them.
                failed++;
                logger.LogError(
                    ex,
                    "Access notice for {SubjectId} could not be delivered to one administrator "
                    + "({UserId}).",
                    subjectUserId,
                    recipient.Id);
            }
        }

        // Counts and ids. Never an address.
        logger.LogInformation(
            "Access notice for {SubjectId}: {Count} of this company's administrators told, "
            + "{FailedCount} not.",
            subjectUserId, told, failed);
    }
}

/// <summary>
/// The HTML part, which is the plain-text notice and nothing more.
///
/// <para>
/// <b>Deliberately not a designed email, and here that is a security choice rather than economy.</b>
/// <see cref="InviteMailBody"/> lays out a button because an invite <em>is</em> a link to click.
/// This message must never look like one: there is nothing in it to press, and a mail carrying a
/// Teren-branded button beside the words "somebody was given access to your company" is the
/// template an attacker would copy. Every line is escaped — a display name is caller text.
/// </para>
/// </summary>
public static class AdminAccessNoticeBody
{
    public static string Html(string text) =>
        "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a\">"
        + string.Concat((text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n')
            .Select(line => line.Length == 0
                ? "<br>"
                : string.Format(
                    System.Globalization.CultureInfo.InvariantCulture,
                    "<p style=\"margin:0 0 10px\">{0}</p>",
                    Escape(line))))
        + "</div>";

    private static string Escape(string value) =>
        value.Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal);
}
