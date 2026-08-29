namespace Teren.Core.Tenancy;

/// <summary>
/// The company the current request acts for. Registered scoped; the DbContext's global query
/// filters read it, so tenant scoping is automatic — no handler ever writes a CompanyId Where
/// clause. Deny-by-default: while <see cref="CompanyId"/> is unset, tenant-scoped queries
/// return nothing.
/// </summary>
public sealed class TenantContext
{
    public Guid? CompanyId { get; set; }
}
