namespace Teren.Core.Entities;

/// <summary>
/// One phone, belonging to one worker at a time (§2 decision 7).
/// <para>
/// <b>There is no expiry on a device token and there must never be a cache in front of this
/// table.</b> The credential is long-lived; the <em>check</em> runs on every request, which is
/// what makes revocation the security control (§2 decision 8). A phone that has been in a
/// basement for a week presents its token, the row says revoked, and it gets 401 on first
/// contact — no push, no sync, nothing to deliver.
/// </para>
/// <para>
/// <b>Revocation is a soft stamp, never a DELETE.</b> <c>entry.device_id</c> is provenance on
/// evidence rows, and an administrative action must not degrade evidence. Note that this is
/// currently a code-level discipline: there is no foreign key from <c>entry.device_id</c> to this
/// table, so the database does not yet refuse a hard delete on its own.
/// </para>
/// </summary>
public sealed class Device
{
    public Guid Id { get; set; }

    public Guid CompanyId { get; set; }

    /// <summary>The worker this phone records as. One device, one person.</summary>
    public Guid UserId { get; set; }

    /// <summary>What the admin recognises it by — "Zoranov telefon".</summary>
    public string Name { get; set; } = null!;

    /// <summary>
    /// SHA-256 hex of the bearer token, unique. <b>This index is the auth path</b>: one indexed
    /// lookup per request, which is only affordable because the stored value is an unsalted hash
    /// of a full-entropy secret rather than a password digest (see <c>CredentialTokens</c>).
    /// </summary>
    public string TokenHash { get; set; } = null!;

    public DateTime CreatedAt { get; set; }
    public DateTime? LastSeenAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    public Guid? RevokedByUserId { get; set; }
}
