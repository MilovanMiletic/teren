namespace Teren.Core.Entities;

/// <summary>
/// The three roles (profile-and-identity §2 decision 1). The rules that bind them to a tenant are
/// mechanical, not conventional: see the CHECK constraints on <c>app_user</c>.
/// </summary>
public enum AppUserRole
{
    /// <summary>Teren staff. Has no company, and can never read entries, transcripts, photos or reports.</summary>
    SuperAdmin,

    /// <summary>The customer. Sees everything his own company does.</summary>
    CompanyAdmin,

    /// <summary>The foreman who records. Activates a phone once and never signs in again.</summary>
    Worker,
}

/// <summary>
/// A person. Not a device — a device credential <em>proves</em> an identity, it no longer
/// <em>is</em> one (§2 decision 7).
/// <para>
/// Four database CHECKs make the role rules impossible to violate rather than merely discouraged,
/// and one of them is worth reading twice: <c>ck_app_user_company_scope</c> asserts
/// <c>(role = 'super_admin') = (company_id IS NULL)</c>, so no INSERT, no UPDATE and no migration
/// can produce a super_admin row that a tenant query filter would ever match.
/// </para>
/// </summary>
public sealed class AppUser
{
    public Guid Id { get; set; }

    /// <summary>NULL if and only if <see cref="Role"/> is <see cref="AppUserRole.SuperAdmin"/>.</summary>
    public Guid? CompanyId { get; set; }

    public AppUserRole Role { get; set; }

    /// <summary>
    /// The worker's durable identity, outliving any phone. Required for workers, absent for
    /// admins (who log in by email). <b>Globally unique</b>, not company-scoped, because the
    /// self-service re-activation flow looks a worker up by username alone and must not have to
    /// ask "which company?" — a man standing next to a broken phone types one thing. Normalised
    /// on write (lowercase, trimmed), CHECK-enforced.
    /// </summary>
    public string? Username { get; set; }

    public string DisplayName { get; set; } = null!;

    /// <summary>
    /// Optional for workers and required for admins (<c>ck_app_user_admin_has_email</c>: an admin
    /// who can never be reset is a support call nobody can answer). Normalised on write rather
    /// than stored as <c>citext</c> — no <c>CREATE EXTENSION</c>, following the "No PostGIS"
    /// precedent.
    /// </summary>
    public string? Email { get; set; }

    /// <summary>
    /// NULL until an admin completes his invite — and NULL <em>forever</em> for a worker, enforced
    /// by <c>ck_app_user_worker_has_no_password</c>. A worker with a password would be a second
    /// door into the diary, and the whole point of the activation model is that there is only one.
    /// </summary>
    public string? PasswordHash { get; set; }

    /// <summary>The person's own language. An invite email speaks this; a report speaks the
    /// project's, because the client reads that one.</summary>
    public string Language { get; set; } = "sr";

    public DateTime CreatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }

    /// <summary>"Remove a worker" is this stamp, never a DELETE: every foreign key into this table
    /// is RESTRICT, so a user who has authored anything can never be hard-deleted.</summary>
    public DateTime? DisabledAt { get; set; }
}
