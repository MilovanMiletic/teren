namespace Teren.Core.Entities;

/// <summary>What a set-password link is for. Both halves use the same machinery (§8).</summary>
public enum PasswordTokenPurpose
{
    /// <summary>First password: the account exists but has never had one.</summary>
    Invite,

    /// <summary>Replacement password for an account that already had one.</summary>
    Reset,
}

/// <summary>
/// A single-use link that lets an admin set a password. 48 hours (§5).
/// <para>
/// Workers never have one, because workers never have a password
/// (<c>ck_app_user_worker_has_no_password</c>).
/// </para>
/// </summary>
public sealed class PasswordToken
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public PasswordTokenPurpose Purpose { get; set; }

    /// <summary>SHA-256 hex of the <c>trn_p_</c> token. The plaintext is never stored: unlike an
    /// activation code, nobody reads this one aloud — it is a URL, and the authenticated re-issue
    /// path (§9) is what unsticks an admin when no relay is configured.</summary>
    public string TokenHash { get; set; } = null!;

    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? ConsumedAt { get; set; }
    public DateTime? SupersededAt { get; set; }
}
