using System.Globalization;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Teren.Api.Auth;
using Teren.Api.Endpoints;
using Teren.Core.Entities;
using Teren.Core.Identity;
using Teren.Core.Reporting;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Jobs;

/// <summary>
/// Emails one worker his own activation code — the job behind
/// <c>POST /auth/activation-code</c> (§2 decision 14).
///
/// <para>
/// <b>The job mints the code; the request does not, and that is the whole point of the file.</b>
/// Minting supersedes whatever live code the man is holding — <c>ux_activation_code_live</c>
/// permits exactly one — so a request that mints and then cannot send has destroyed a usable
/// credential and produced nothing. That route is <em>unauthenticated and takes a username</em>,
/// and usernames are guessable (<c>UsernameFormat.Propose</c> derives one from a display name, and
/// company and worker names are public), so anyone at all could invalidate the code a foreman was
/// about to type on a site. Moving the mint inside the job makes the destructive half and the
/// delivery half one act: every reason not to send — no address, no relay, a suspended company, a
/// disabled account — is checked <b>before</b> anything is written, and the man's live code
/// survives untouched.
/// </para>
///
/// <para>
/// <b>Nothing about the code reaches Hangfire's storage.</b> The argument is a user id, exactly as
/// <see cref="AdminInviteJob"/> takes one: the plaintext exists in one process for one method call
/// and reaches nothing but the relay. The plan refuses that trade for activation codes (§5) and
/// this is the same refusal.
/// </para>
///
/// <para>
/// <b><c>[AutomaticRetry(Attempts = 0)]</c>, like every job in this product</b>, and here for a
/// sharper reason than most: every retry would mint a new code and supersede the last, so a
/// flapping relay would mail a man a stack of codes of which only the final one works — and each
/// one would have invalidated the one before. Failing once and visibly is the better answer; his
/// admin can read him a code off <c>/company</c>, which is the channel the whole design keeps
/// deliberately available.
/// </para>
/// </summary>
[AutomaticRetry(Attempts = 0)]
public sealed class WorkerCodeMailJob(
    TerenIdentityDbContext db,
    Core.Mail.IMailSender mail,
    IOptions<AuthOptions> authOptions,
    ILogger<WorkerCodeMailJob> logger)
{
    public async Task RunAsync(Guid userId, CancellationToken ct)
    {
        // Guid.Empty is the ordinary case, not an error: the route enqueues for every request so
        // that an unknown username costs exactly what a known one costs, and there is no user to
        // name when nobody typed a real one.
        if (userId == Guid.Empty)
        {
            return;
        }

        var worker = await db.Users.FirstOrDefaultAsync(
            u => u.Id == userId
                && u.Role == AppUserRole.Worker
                && u.DisabledAt == null,
            ct);

        if (worker is null || worker.Email is null || worker.Username is null)
        {
            // A code nobody can be sent is not worth destroying a usable one for. Nothing is
            // minted and nothing is written.
            logger.LogInformation(
                "Activation-code mail skipped for {UserId}: no such active worker, or no address "
                + "on file. His live code is untouched.", userId);
            return;
        }

        if (worker.CompanyId is not Guid companyId
            || !await db.Companies.AnyAsync(c => c.Id == companyId && c.SuspendedAt == null, ct))
        {
            logger.LogWarning(
                "Activation-code mail skipped for {UserId}: his company is suspended or missing.",
                userId);
            return;
        }

        if (!mail.IsConfigured)
        {
            // This is the ONLY relay check on this path — the route holds no IMailSender and checks
            // nothing (by design: it must not branch). It stands between "mint" and nothing.
            logger.LogWarning(
                "Activation-code mail skipped for {UserId}: no relay is configured. His live code "
                + "is untouched; issue one from /company and read it out instead.", userId);
            return;
        }

        // The actor is the worker himself, which is exactly what the audit column should say.
        var code = await ActivationCodes.IssueAsync(
            db,
            worker,
            worker.Id,
            AdminAuditActions.ActivationCodeSelfRequested,
            authOptions.Value.ActivationCodeLifetime,
            mail.IsConfigured,
            ct);

        // His language, not the company's and not a project's: a report speaks the project's
        // language because the client reads it; this speaks his, because he does.
        var strings = InviteStrings.For(worker.Language);

        // The same words the admin pastes into a chat (GET /api/workers/{id}/share-text), from the
        // same builder. One copy of the message the founder has to review, and a man who gets it
        // both ways reads the same two lines either way.
        var text = strings.WorkerActivationMessage(
            worker.DisplayName,
            worker.Username,
            code.Code,
            code.ExpiresAt.UtcDateTime,
            // The market's zone. A person carries no time zone, and an expiry printed a day out
            // is a support call.
            ReportTimeZone.Resolve(ReportTimeZone.Default),
            authOptions.Value.AppUrl);

        await mail.SendAsync(
            new Core.Mail.MailMessage
            {
                ToAddress = worker.Email,
                ToName = worker.DisplayName,
                Subject = strings.MailSubject,
                TextBody = text,
                HtmlBody = WorkerCodeMailBody.Html(text),
            },
            ct);

        // The id and nothing else. Never the address, never the code.
        logger.LogInformation("Activation-code mail sent for {UserId}.", userId);
    }
}

/// <summary>
/// The HTML part, which is the plain-text message and nothing more.
///
/// <para>
/// <b>Deliberately not a designed email.</b> <see cref="InviteMailBody"/> lays out a button
/// because an invite is a link to click; this message is two short lines a man reads off a phone
/// and types into an app, and a marketing layout around them would only give a mail client more
/// ways to mangle a code. Every line is escaped — a display name is caller text.
/// </para>
/// </summary>
public static class WorkerCodeMailBody
{
    public static string Html(string text) =>
        "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a\">"
        + string.Concat((text ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n')
            .Select(line => line.Length == 0
                ? "<br>"
                : string.Format(
                    CultureInfo.InvariantCulture, "<p style=\"margin:0 0 6px\">{0}</p>", Escape(line))))
        + "</div>";

    private static string Escape(string value) =>
        value.Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal);
}
