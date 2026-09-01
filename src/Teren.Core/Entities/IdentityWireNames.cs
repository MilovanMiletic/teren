namespace Teren.Core.Entities;

/// <summary>
/// How <see cref="AppUserRole"/> is spelled outside C#: in the <c>app_user.role</c> column, in the
/// <c>ck_app_user_role</c> CHECK constraint, and (from D2) in API JSON. One definition, exactly as
/// <see cref="EntryStatusNames"/> does it, so the stored value and the wire value cannot drift.
/// </summary>
public static class AppUserRoleNames
{
    public const string SuperAdmin = "super_admin";
    public const string CompanyAdmin = "company_admin";
    public const string Worker = "worker";

    /// <summary>The CHECK constraint's value list, built from the same constants the code uses —
    /// so a rename cannot leave the constraint naming a role that no longer exists.</summary>
    public static readonly string[] All = [SuperAdmin, CompanyAdmin, Worker];

    public static string ToWire(AppUserRole role) => role switch
    {
        AppUserRole.SuperAdmin => SuperAdmin,
        AppUserRole.CompanyAdmin => CompanyAdmin,
        AppUserRole.Worker => Worker,
        _ => throw new ArgumentOutOfRangeException(nameof(role), role, null),
    };

    public static AppUserRole Parse(string value) => value switch
    {
        SuperAdmin => AppUserRole.SuperAdmin,
        CompanyAdmin => AppUserRole.CompanyAdmin,
        Worker => AppUserRole.Worker,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}

/// <summary>
/// The verbs <c>admin_audit.action</c> is written with. Constants rather than literals at the call
/// site because an audit trail whose verbs drift is an audit trail nobody can filter: "who revoked
/// this phone" has to be one query six months from now, not three spellings of one word.
/// <para>
/// snake_case, past tense, subject first — the shape a log line reads in.
/// </para>
/// </summary>
public static class AdminAuditActions
{
    public const string WorkerCreated = "worker_created";
    public const string WorkerUpdated = "worker_updated";
    public const string WorkerDisabled = "worker_disabled";
    public const string WorkerEnabled = "worker_enabled";

    public const string ActivationCodeIssued = "activation_code_issued";

    /// <summary>The self-service path (§2 decision 14): the worker asked for his own code. The
    /// actor is the worker himself, which is exactly what the column should say.</summary>
    public const string ActivationCodeSelfRequested = "activation_code_self_requested";

    public const string DeviceActivated = "device_activated";
    public const string DeviceRevoked = "device_revoked";

    /// <summary>A previous phone withdrawn because its owner activated a new one — the automatic
    /// half of activation (§14 question 2), distinguished from an admin pressing revoke so that
    /// "who took this phone away" has a truthful answer.</summary>
    public const string DeviceSuperseded = "device_superseded";

    public const string SuperAdminCreated = "super_admin_created";

    public const string CompanyCreated = "company_created";

    /// <summary>
    /// Teren staff brought an administrator into being — a company admin, or another member of
    /// staff.
    /// <para>
    /// **The very first super admin is not audited by this**, and cannot be: he is seeded, by
    /// `create-super-admin` or by the production seed, before any actor exists to name. Every
    /// admin after him arrives through `POST /api/platform/users` and is recorded here with the
    /// person who created him. That asymmetry is worth knowing when reading the trail: an account
    /// with no `admin_created` row is the bootstrap one.
    /// </para>
    /// </summary>
    public const string AdminCreated = "admin_created";

    /// <summary>Teren staff withdrew a customer's access. Every credential belonging to that
    /// company stops authenticating on next contact — which is why it is audited and why the
    /// screen that does it has to say so.</summary>
    public const string CompanySuspended = "company_suspended";

    public const string CompanyResumed = "company_resumed";

    /// <summary>
    /// Distinct from <see cref="WorkerDisabled"/>, and not merely for tidiness.
    /// <para>
    /// A company admin disabling one of his own foremen and Teren staff disabling *any* account
    /// are different acts with different reach, and the audit trail is read to answer "who did
    /// this to me". Collapsing them would make the customer's own action and the platform's
    /// indistinguishable in the one record that exists to tell them apart.
    /// </para>
    /// </summary>
    public const string UserDisabled = "user_disabled";

    public const string UserEnabled = "user_enabled";

    /// <summary>A set-password link was minted (invite or reset). Distinguished from
    /// <see cref="PasswordSet"/> because "who was invited and never completed it" and "who
    /// actually has a password" are different questions, and only the pair answers either.</summary>
    public const string PasswordTokenIssued = "password_token_issued";

    public const string PasswordSet = "password_set";
}

public static class PasswordTokenPurposeNames
{
    public const string Invite = "invite";
    public const string Reset = "reset";

    public static readonly string[] All = [Invite, Reset];

    public static string ToWire(PasswordTokenPurpose purpose) => purpose switch
    {
        PasswordTokenPurpose.Invite => Invite,
        PasswordTokenPurpose.Reset => Reset,
        _ => throw new ArgumentOutOfRangeException(nameof(purpose), purpose, null),
    };

    public static PasswordTokenPurpose Parse(string value) => value switch
    {
        Invite => PasswordTokenPurpose.Invite,
        Reset => PasswordTokenPurpose.Reset,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null),
    };
}
