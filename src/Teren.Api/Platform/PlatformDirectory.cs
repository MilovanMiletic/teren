using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Teren.Api.Auth;
using Teren.Api.Contracts;
using Teren.Api.Endpoints;
using Teren.Core.Entities;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Platform;

/// <summary>
/// Everything Teren staff can see and do: companies, accounts, and the trail of what was done.
///
/// <para>
/// <b>This class is the surface the privacy proof is written against.</b>
/// <c>PlatformPrivacyTests</c> reflects over every public member here and fails if a parameter or
/// return type transitively mentions <c>Entry</c>, <c>Media</c> or <c>Report</c> — which is the
/// test that goes red the day somebody adds <c>entry_count</c> to a company DTO. That is how this
/// boundary would actually be lost: not by a breach, but by one useful-looking field on a screen
/// nobody thought of as sensitive. Keeping the whole platform surface behind one named type is
/// what makes such a guard possible at all.
/// </para>
///
/// <para>
/// <b>It resolves <see cref="TerenIdentityDbContext"/> and nothing else.</b> That is layer 3 of
/// the four (plan §6): the identity model has no <c>DbSet&lt;Entry&gt;</c>, no <c>Media</c> and no
/// <c>Report</c>, so <c>db.Set&lt;Entry&gt;()</c> throws at runtime because the type is not in the
/// model. "Super admin cannot read evidence" therefore stops being a policy this code applies and
/// becomes a property of the model this code is compiled against.
/// </para>
///
/// <para>
/// <b>No <c>IgnoreQueryFilters()</c> appears here, and none is needed.</b> The identity context
/// carries no query filters at all, deliberately (see <see cref="IdentityScope"/>), so these
/// queries are unfiltered by construction rather than by escape hatch — which is what keeps that
/// call confined to <c>DemoSeeder.cs</c> across the whole of <c>src/</c>, asserted by
/// <c>IdentityModelTests</c>. Scoping here is *supposed* to be absent: a super admin's reach over
/// accounts is the point of the role. His reach over evidence is stopped by three other layers.
/// </para>
///
/// <para>
/// Every list pages by keyset (see <see cref="Keyset"/>), never by offset.
/// </para>
/// </summary>
public sealed class PlatformDirectory(
    TerenIdentityDbContext db,
    IOptions<AuthOptions> authOptions)
{
    /// <summary>How long a set-password link lives. Matches the console command's default; §5's
    /// table says 48 h, single use.</summary>
    public static readonly TimeSpan PasswordTokenLifetime = TimeSpan.FromHours(48);

    // ------------------------------------------------------------------------------ companies

    /// <summary>
    /// The customers, newest first, with the two counts that answer "is this one set up or stuck?".
    /// </summary>
    public async Task<PlatformCompanyListResponse> ListCompaniesAsync(
        string? q, Keyset? after, int? limit, CancellationToken ct)
    {
        var take = Keyset.Limit(limit);

        var query = db.Companies.AsNoTracking().AsQueryable();

        if (Search.Wanted(q, out var pattern))
        {
            query = query.Where(c => EF.Functions.ILike(c.Name, pattern));
        }

        // Strictly after the cursor row in (created_at DESC, id DESC). The OR arm is what makes
        // ties correct: rows sharing a timestamp are separated by id, so none is skipped and none
        // repeats. `created_at` alone is not unique — a seeded company and its admin are written
        // in one transaction and can share it to the microsecond.
        if (after is { } cursor)
        {
            query = query.Where(c =>
                c.CreatedAt < cursor.CreatedAt
                || (c.CreatedAt == cursor.CreatedAt && c.Id < cursor.Id));
        }

        // One row more than asked for, which is how the cursor knows whether there is a next page
        // without counting the table. A COUNT(*) to render a page somebody is scrolling is work
        // nobody asked for, and the answer goes stale while he reads it.
        var rows = await query
            .OrderByDescending(c => c.CreatedAt).ThenByDescending(c => c.Id)
            .Take(take + 1)
            .Select(c => new
            {
                c.Id,
                c.Name,
                c.CreatedAt,
                c.SuspendedAt,
                UserCount = db.Users.Count(u => u.CompanyId == c.Id),
                ActiveUserCount = db.Users.Count(u => u.CompanyId == c.Id && u.DisabledAt == null),
            })
            .ToListAsync(ct);

        var page = rows.Take(take).ToList();

        return new PlatformCompanyListResponse(
            page.Select(c => new PlatformCompanyResponse(
                    c.Id,
                    c.Name,
                    Utc(c.CreatedAt),
                    UtcOrNull(c.SuspendedAt),
                    c.UserCount,
                    c.ActiveUserCount))
                .ToList(),
            NextCursor(rows.Count > take, page.Count == 0 ? null : new Keyset(page[^1].CreatedAt, page[^1].Id)));
    }

    /// <summary>
    /// Create a customer. Nothing else is created with it — no admin, no project — because an
    /// empty company is a truthful state and inventing an account nobody asked for is how a
    /// credential ends up somewhere nobody remembers.
    /// </summary>
    public async Task<PlatformCompanyResponse> CreateCompanyAsync(
        string name, Guid actorUserId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var company = new Company { Id = Guid.NewGuid(), Name = name.Trim(), CreatedAt = now };

        db.Companies.Add(company);
        db.AdminAudits.Add(Audit(
            actorUserId, AdminAuditActions.CompanyCreated, "company", company.Id, company.Id, now));

        await db.SaveChangesAsync(ct);

        return new PlatformCompanyResponse(company.Id, company.Name, Utc(now), null, 0, 0);
    }

    /// <summary>
    /// Withdraw or restore a customer's access, or null when there is no such company.
    ///
    /// <para>
    /// <b>Suspending is the heaviest button on this surface and the screen has to say so.</b>
    /// The authenticator joins <c>company.suspended_at</c> on every request, so the moment this
    /// lands, every phone and every session belonging to that customer starts getting a 401 on
    /// next contact — with no cache and no expiry to wait out. The foremen keep recording (their
    /// entries queue and heal), but nothing they have already captured gets through until it is
    /// resumed.
    /// </para>
    /// <para>
    /// Idempotent on purpose: suspending a suspended company keeps the original timestamp rather
    /// than restamping it. The column answers "since when", and a second press must not rewrite
    /// the answer.
    /// </para>
    /// </summary>
    public async Task<PlatformCompanyResponse?> SetCompanySuspendedAsync(
        Guid companyId, bool suspended, Guid actorUserId, CancellationToken ct)
    {
        var company = await db.Companies.FirstOrDefaultAsync(c => c.Id == companyId, ct);
        if (company is null)
        {
            return null;
        }

        var now = DateTime.UtcNow;
        var changing = suspended ? company.SuspendedAt is null : company.SuspendedAt is not null;

        if (changing)
        {
            company.SuspendedAt = suspended ? now : null;
            db.AdminAudits.Add(Audit(
                actorUserId,
                suspended ? AdminAuditActions.CompanySuspended : AdminAuditActions.CompanyResumed,
                "company",
                company.Id,
                company.Id,
                now));
            await db.SaveChangesAsync(ct);
        }

        var userCount = await db.Users.CountAsync(u => u.CompanyId == company.Id, ct);
        var activeCount = await db.Users
            .CountAsync(u => u.CompanyId == company.Id && u.DisabledAt == null, ct);

        return new PlatformCompanyResponse(
            company.Id, company.Name, Utc(company.CreatedAt), UtcOrNull(company.SuspendedAt),
            userCount, activeCount);
    }

    // ---------------------------------------------------------------------------------- users

    /// <summary>
    /// Every account, filtered the four ways a founder actually needs.
    ///
    /// <para>
    /// <c>status=pending</c> means <c>password_hash IS NULL</c> — an admin who was invited and
    /// never finished — and it is the filter he will reach for when chasing an onboarding that
    /// stalled. Workers have no password by construction
    /// (<c>ck_app_user_worker_has_no_password</c>), so they are all "pending" by that definition
    /// and the filter is combined with <c>role</c> in practice; that is a property of the data,
    /// not a bug in the filter, and pretending otherwise would mean the filter lying about a
    /// column.
    /// </para>
    /// </summary>
    public async Task<PlatformUserListResponse> ListUsersAsync(
        Guid? companyId,
        AppUserRole? role,
        UserStatusFilter status,
        string? q,
        Keyset? after,
        int? limit,
        CancellationToken ct)
    {
        var take = Keyset.Limit(limit);
        var query = db.Users.AsNoTracking().AsQueryable();

        if (companyId is not null)
        {
            query = query.Where(u => u.CompanyId == companyId);
        }

        if (role is not null)
        {
            query = query.Where(u => u.Role == role);
        }

        query = status switch
        {
            UserStatusFilter.Pending => query.Where(u => u.PasswordHash == null),
            UserStatusFilter.Active => query.Where(u => u.DisabledAt == null),
            UserStatusFilter.Disabled => query.Where(u => u.DisabledAt != null),
            _ => query,
        };

        if (Search.Wanted(q, out var pattern))
        {
            // Name, address and username together: a founder searching knows one of the three and
            // should not have to know which field it lives in.
            query = query.Where(u =>
                EF.Functions.ILike(u.DisplayName, pattern)
                || (u.Email != null && EF.Functions.ILike(u.Email, pattern))
                || (u.Username != null && EF.Functions.ILike(u.Username, pattern)));
        }

        if (after is { } cursor)
        {
            query = query.Where(u =>
                u.CreatedAt < cursor.CreatedAt
                || (u.CreatedAt == cursor.CreatedAt && u.Id < cursor.Id));
        }

        var rows = await query
            .OrderByDescending(u => u.CreatedAt).ThenByDescending(u => u.Id)
            .Take(take + 1)
            .Select(u => new
            {
                u.Id,
                u.CompanyId,
                CompanyName = db.Companies
                    .Where(c => c.Id == u.CompanyId)
                    .Select(c => c.Name)
                    .FirstOrDefault(),
                u.Role,
                u.Username,
                u.DisplayName,
                u.Email,
                u.Language,
                u.CreatedAt,
                u.LastLoginAt,
                u.DisabledAt,
                PasswordPending = u.PasswordHash == null,
            })
            .ToListAsync(ct);

        var page = rows.Take(take).ToList();

        return new PlatformUserListResponse(
            page.Select(u => new PlatformUserResponse(
                    u.Id,
                    u.CompanyId,
                    u.CompanyName,
                    AppUserRoleNames.ToWire(u.Role),
                    u.Username,
                    u.DisplayName,
                    u.Email,
                    u.Language,
                    Utc(u.CreatedAt),
                    UtcOrNull(u.LastLoginAt),
                    UtcOrNull(u.DisabledAt),
                    u.PasswordPending))
                .ToList(),
            NextCursor(rows.Count > take, page.Count == 0 ? null : new Keyset(page[^1].CreatedAt, page[^1].Id)));
    }

    /// <summary>
    /// Disable or re-enable one account, or null when there is no such user.
    ///
    /// <para>
    /// <b>A soft stamp, never a delete</b>, and the FK would refuse anyway: a user who has
    /// authored an entry is referenced by evidence, and an administrative action must not degrade
    /// evidence. "Remove this person" is <c>disabled_at</c>, permanently.
    /// </para>
    /// <para>
    /// Idempotent for the same reason suspension is: the column answers "since when".
    /// </para>
    /// </summary>
    public async Task<PlatformUserResponse?> SetUserDisabledAsync(
        Guid userId, bool disabled, Guid actorUserId, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null)
        {
            return null;
        }

        var now = DateTime.UtcNow;
        var changing = disabled ? user.DisabledAt is null : user.DisabledAt is not null;

        if (changing)
        {
            user.DisabledAt = disabled ? now : null;
            db.AdminAudits.Add(Audit(
                actorUserId,
                disabled ? AdminAuditActions.UserDisabled : AdminAuditActions.UserEnabled,
                "app_user",
                user.Id,
                user.CompanyId,
                now));
            await db.SaveChangesAsync(ct);
        }

        return await DescribeUserAsync(user, ct);
    }

    /// <summary>
    /// Mint a set-password link for an account, or null when there is no such user.
    ///
    /// <para>
    /// <b>This is §9's authenticated escape hatch, and it is why a locked-out customer is not
    /// stuck until an SMTP relay exists.</b> The plaintext token comes back in the response so the
    /// founder can read the link down the phone. The unauthenticated
    /// <c>/auth/password-reset</c> must never do the same, because there the token would also
    /// confirm whether the account exists.
    /// </para>
    /// <para>
    /// <b>It is not free, and the cost belongs here rather than in a risk register nobody opens.</b>
    /// A <c>reset</c> — a token for an account that already has a password — is a working
    /// impersonation path: <c>POST /auth/password</c> is unauthenticated and checks only the token,
    /// so whoever holds it can take that admin's account and read his company's diaries. That
    /// contradicts plan decision 2 as literally worded, and it is carried as a named founder risk
    /// in §13. The capability is older than this route (<c>invite-admin</c> has done it from a
    /// terminal since D2); what changed is that it is now reachable through the product.
    /// **Do not "fix" it by deleting this method** — a locked-out admin with no relay has no other
    /// way back, which is the entire reason §9 specifies it. Narrowing it to <c>invite</c> only
    /// would close the impersonation path and take the support case with it; that trade is the
    /// founder's to make.
    /// </para>
    /// <para>
    /// Refused for a worker: <c>ck_app_user_worker_has_no_password</c> makes a worker's password
    /// hash impossible, so a link that could only ever fail a CHECK is worse than an honest
    /// refusal. His way back is a fresh activation code.
    /// </para>
    /// </summary>
    public async Task<InviteUserResponse?> InviteAsync(
        Guid userId, Guid actorUserId, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null || user.Role == AppUserRole.Worker)
        {
            return null;
        }

        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        var issued = await PasswordTokens.IssueAsync(
            db, user, actorUserId, "platform", PasswordTokenLifetime, ct);

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);

        return new InviteUserResponse(
            PasswordTokenPurposeNames.ToWire(issued.Purpose),
            issued.Token,
            PasswordTokens.LinkFor(authOptions.Value.AppUrl, issued.Token),
            Utc(issued.ExpiresAt),
            issued.Superseded);
    }

    // ---------------------------------------------------------------------------------- audit

    /// <summary>
    /// What administrators have done, newest first. The answer to "who took this phone away" and
    /// "who was invited and never finished".
    /// </summary>
    public async Task<PlatformAuditListResponse> ListAuditAsync(
        Guid? companyId, string? action, Keyset? after, int? limit, CancellationToken ct)
    {
        var take = Keyset.Limit(limit);
        var query = db.AdminAudits.AsNoTracking().AsQueryable();

        if (companyId is not null)
        {
            query = query.Where(a => a.CompanyId == companyId);
        }

        if (!string.IsNullOrWhiteSpace(action))
        {
            // Exact, not a search: actions are a fixed snake_case vocabulary, and a substring
            // match would quietly fold `worker_disabled` and `user_disabled` into one filter —
            // the two the audit trail exists to keep apart.
            var wanted = action.Trim();
            query = query.Where(a => a.Action == wanted);
        }

        if (after is { } cursor)
        {
            query = query.Where(a =>
                a.CreatedAt < cursor.CreatedAt
                || (a.CreatedAt == cursor.CreatedAt && a.Id < cursor.Id));
        }

        var rows = await query
            .OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id)
            .Take(take + 1)
            .Select(a => new
            {
                a.Id,
                a.ActorUserId,
                ActorDisplayName = db.Users
                    .Where(u => u.Id == a.ActorUserId)
                    .Select(u => u.DisplayName)
                    .FirstOrDefault(),
                a.Action,
                a.SubjectType,
                a.SubjectId,
                a.CompanyId,
                a.Detail,
                a.CreatedAt,
            })
            .ToListAsync(ct);

        var page = rows.Take(take).ToList();

        return new PlatformAuditListResponse(
            page.Select(a => new PlatformAuditResponse(
                    a.Id,
                    a.ActorUserId,
                    a.ActorDisplayName,
                    a.Action,
                    a.SubjectType,
                    a.SubjectId,
                    a.CompanyId,
                    a.Detail,
                    Utc(a.CreatedAt)))
                .ToList(),
            NextCursor(rows.Count > take, page.Count == 0 ? null : new Keyset(page[^1].CreatedAt, page[^1].Id)));
    }

    // --------------------------------------------------------------------------------- shared

    private async Task<PlatformUserResponse> DescribeUserAsync(AppUser user, CancellationToken ct)
    {
        var companyName = user.CompanyId is null
            ? null
            : await db.Companies
                .Where(c => c.Id == user.CompanyId)
                .Select(c => c.Name)
                .FirstOrDefaultAsync(ct);

        return new PlatformUserResponse(
            user.Id,
            user.CompanyId,
            companyName,
            AppUserRoleNames.ToWire(user.Role),
            user.Username,
            user.DisplayName,
            user.Email,
            user.Language,
            Utc(user.CreatedAt),
            UtcOrNull(user.LastLoginAt),
            UtcOrNull(user.DisabledAt),
            user.PasswordHash is null);
    }

    private static string? NextCursor(bool hasMore, Keyset? last) =>
        hasMore && last is { } keyset ? keyset.Encode() : null;

    private static AdminAudit Audit(
        Guid actorUserId,
        string action,
        string subjectType,
        Guid subjectId,
        Guid? companyId,
        DateTime at) =>
        new()
        {
            Id = Guid.NewGuid(),
            ActorUserId = actorUserId,
            Action = action,
            SubjectType = subjectType,
            SubjectId = subjectId,
            CompanyId = companyId,
            CreatedAt = at,
        };

    private static DateTimeOffset Utc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static DateTimeOffset? UtcOrNull(DateTime? value) =>
        value is null ? null : Utc(value.Value);
}

/// <summary>Which accounts a caller wants to see. `Any` is the default and means no filter.</summary>
public enum UserStatusFilter
{
    Any,
    /// <summary>Invited and never finished: <c>password_hash IS NULL</c>.</summary>
    Pending,
    Active,
    Disabled,
}

/// <summary>
/// Free-text search, escaped.
/// <para>
/// <c>%</c> and <c>_</c> are wildcards in <c>ILIKE</c>, so a founder searching for a literal
/// underscore in a username would otherwise get a single-character wildcard and a puzzling result
/// set. Escaping them is the difference between a search box and a small query language nobody
/// documented.
/// </para>
/// </summary>
internal static class Search
{
    public static bool Wanted(string? q, out string pattern)
    {
        if (string.IsNullOrWhiteSpace(q))
        {
            pattern = string.Empty;
            return false;
        }

        var escaped = q.Trim()
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);

        pattern = $"%{escaped}%";
        return true;
    }
}
