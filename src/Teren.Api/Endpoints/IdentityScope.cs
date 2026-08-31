using Microsoft.EntityFrameworkCore;
using Teren.Core.Entities;
using Teren.Infrastructure.Persistence;

namespace Teren.Api.Endpoints;

/// <summary>
/// The company where-clause for the identity tables, written once so a reviewer has one file to
/// check rather than a dozen handlers to audit.
/// <para>
/// <b>Read this before writing another admin handler.</b> Everywhere else in this API, tenant
/// scoping is automatic: <c>TerenDbContext</c>'s global query filters are deny-by-default, so no
/// handler ever writes a <c>CompanyId</c> comparison and forgetting one is impossible.
/// <b><see cref="TerenIdentityDbContext"/> deliberately has no query filters at all</b> — it must
/// not have any, because the credential authenticator has to read <c>device</c> →
/// <c>app_user</c> → <c>company</c> <em>before</em> any tenant is known, and that is what keeps
/// <c>IgnoreQueryFilters()</c> out of the auth path and confined to one file under <c>src/</c>
/// (profile-and-identity §6; <c>IdentityModelTests.The_identity_model_carries_no_query_filters</c>
/// pins it).
/// </para>
/// <para>
/// So on the identity model the scoping is <b>manual, and a forgotten clause is a cross-tenant
/// read</b>. Note that this contradicts §8 of the plan, which says company-wide scope is free
/// "because these tables carry the same global query filter" — they do not, and that sentence was
/// written before D1 chose the two-context split. Every admin query goes through one of the
/// helpers below, and <c>CompanyAdminSurfaceTests</c> proves each route answers 404 for another
/// company's row.
/// </para>
/// </summary>
internal static class IdentityScope
{
    /// <summary>The company's foremen. Admins are excluded here on purpose: the worker surface
    /// manages people who record, and a company admin editing his own row is <c>/api/me</c>.</summary>
    public static IQueryable<AppUser> WorkersOf(this TerenIdentityDbContext db, Guid companyId) =>
        db.Users.Where(u => u.CompanyId == companyId && u.Role == AppUserRole.Worker);

    /// <summary>The company's phones, revoked ones included — a revoked row is history, and the
    /// list is where an admin checks that a phone he took away really is gone.</summary>
    public static IQueryable<Device> DevicesOf(this TerenIdentityDbContext db, Guid companyId) =>
        db.Devices.Where(d => d.CompanyId == companyId);

    /// <summary>
    /// One worker of this company, or null — which the caller turns into the same 404 a
    /// nonexistent id gets. Another company's worker is <b>not</b> a 403: it is a question about
    /// existence, and the answer to "does this row exist" never depends on who is asking.
    /// </summary>
    public static Task<AppUser?> WorkerOrNullAsync(
        this TerenIdentityDbContext db, Guid companyId, Guid workerId, CancellationToken ct) =>
        db.WorkersOf(companyId).FirstOrDefaultAsync(u => u.Id == workerId, ct);
}
