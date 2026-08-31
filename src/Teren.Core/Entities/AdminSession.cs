namespace Teren.Core.Entities;

/// <summary>
/// A signed-in admin. 30 days, or 8 hours for a super admin (§5).
/// <para>
/// <b>No IP address and no user-agent.</b> ARCHITECTURE §12 keeps personal data out of logs;
/// nothing reads either column, and they would be the first thing to leak into a log line.
/// </para>
/// <para>
/// Deliberately a database row rather than a JWT. The entire security model is revocation, and a
/// JWT is a credential the server cannot take back without a revocation list — that is, a
/// database lookup per request, which is the thing a JWT was supposed to avoid.
/// </para>
/// </summary>
public sealed class AdminSession
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    /// <summary>SHA-256 hex of the <c>trn_s_</c> token.</summary>
    public string TokenHash { get; set; } = null!;

    public DateTime CreatedAt { get; set; }
    public DateTime LastSeenAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}
