namespace Teren.Core.Entities;

/// <summary>
/// What an administrator did. Written by the admin surfaces (D3/D4), never by the phone path.
/// <para>
/// <see cref="Detail"/> is JSONB and is the one place an administrative action can carry
/// structure, so the same rule that governs logs governs it: ids, counts and outcomes — never
/// transcript, note, structure or recipient content.
/// </para>
/// </summary>
public sealed class AdminAudit
{
    public Guid Id { get; set; }

    /// <summary>Who did it. RESTRICT, so an actor who has audited anything can never be deleted.</summary>
    public Guid ActorUserId { get; set; }

    /// <summary>What was done, as a stable snake_case verb — "device_revoked", "worker_invited".</summary>
    public string Action { get; set; } = null!;

    /// <summary>What it was done to: "device", "app_user", "company".</summary>
    public string SubjectType { get; set; } = null!;

    public Guid? SubjectId { get; set; }

    /// <summary>The tenant the action landed in. NULL for a platform-level action with no company.</summary>
    public Guid? CompanyId { get; set; }

    public string? Detail { get; set; }

    public DateTime CreatedAt { get; set; }
}
