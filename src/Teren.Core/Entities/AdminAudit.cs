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

    /// <summary>
    /// The one way an audit row is built.
    ///
    /// <para>
    /// Six call sites across the admin surfaces used to spell out the same object initialiser, and
    /// a seventh — <c>PlatformDirectory</c> — had already extracted a private copy of it. That is
    /// not a tidiness complaint: <see cref="Id"/> is client-generated, so a row written with a
    /// forgotten <c>Guid.NewGuid()</c> inserts under <c>Guid.Empty</c> and the <em>second</em> such
    /// row is the one that fails, on a primary key, in whatever unrelated request happened to run
    /// next. A factory makes the required fields required.
    /// </para>
    ///
    /// <para>
    /// <paramref name="detail"/> is JSONB and carries the same rule as a log line — ids, counts and
    /// outcomes, never transcript, note, structure or recipient content.
    /// </para>
    /// </summary>
    public static AdminAudit For(
        Guid actorUserId,
        string action,
        string subjectType,
        Guid? subjectId,
        Guid? companyId,
        DateTime at,
        string? detail = null) =>
        new()
        {
            Id = Guid.NewGuid(),
            ActorUserId = actorUserId,
            Action = action,
            SubjectType = subjectType,
            SubjectId = subjectId,
            CompanyId = companyId,
            Detail = detail,
            CreatedAt = at,
        };
}
