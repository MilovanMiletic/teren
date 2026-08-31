namespace Teren.Core.Entities;

/// <summary>
/// A one-time code that lets a worker bind a phone to his username (§5).
/// <para>
/// <b>Single use, and this is the point on which the design refuses to bend.</b> A reusable code
/// tied to a username is not an activation code; it is a permanent password shared over WhatsApp
/// that never expires, and anyone who ever saw that message could record entries under that
/// worker's name — with the report saying it was him. Device replacement is solved by issuing a
/// new code cheaply (§2 decision 14), never by making one code last forever.
/// </para>
/// <para>
/// Activation takes a username <em>and</em> a code, so a code seen over a shoulder or left in a
/// group chat is useless on its own. <see cref="CodeHash"/> is the only authentication input.
/// </para>
/// </summary>
public sealed class ActivationCode
{
    public Guid Id { get; set; }

    public Guid CompanyId { get; set; }

    /// <summary>The worker this code activates a phone for.</summary>
    public Guid UserId { get; set; }

    /// <summary>The admin who issued it — or the worker himself, on the self-service path.</summary>
    public Guid CreatedByUserId { get; set; }

    /// <summary>SHA-256 hex of the folded code. The only thing activation ever compares against.</summary>
    public string CodeHash { get; set; } = null!;

    /// <summary>
    /// The plaintext code, held <b>while and only while the code is live</b>, and nulled by
    /// consumption, supersession and expiry (<c>ck_activation_code_display_cleared</c> enforces
    /// the first two; the third cannot be a CHECK because a partial predicate must be immutable).
    /// <para>
    /// This is a deliberate reversal of "hash only", for two reasons. Operationally, re-issue as
    /// the way to "see the code again" silently kills the code the worker is about to type. And
    /// the invite email is sent from a Hangfire job (principle 4), which needs the plaintext —
    /// the alternative is passing it as a job argument, which Hangfire serialises into its own
    /// database and keeps in job history. Strictly worse.
    /// </para>
    /// <para>
    /// The database therefore never holds a plaintext credential that is not currently usable
    /// anyway, and this column could be dropped tomorrow with no change to the auth path.
    /// </para>
    /// </summary>
    public string? CodeDisplay { get; set; }

    public DateTime CreatedAt { get; set; }

    /// <summary>Checked at activation time, never in an index predicate.</summary>
    public DateTime ExpiresAt { get; set; }

    public DateTime? ConsumedAt { get; set; }

    /// <summary>The phone this code produced, once it has produced one.</summary>
    public Guid? ConsumedDeviceId { get; set; }

    /// <summary>Set when a newer code replaced this one. Together with <see cref="ConsumedAt"/>
    /// this drives <c>ux_activation_code_live</c>: at most one typeable code per worker,
    /// guaranteed by the database rather than by a handler remembering to expire the old one.</summary>
    public DateTime? SupersededAt { get; set; }
}
