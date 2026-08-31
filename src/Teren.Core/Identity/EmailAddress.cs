namespace Teren.Core.Identity;

/// <summary>
/// The login key for both admin roles, and the optional-but-normal way a worker receives a code.
/// <para>
/// <b>Normalised on write rather than stored as <c>citext</c></b> — no <c>CREATE EXTENSION</c>,
/// following the "No PostGIS" precedent — and the database agrees:
/// <c>ck_app_user_email_normalised</c> asserts <c>email = lower(btrim(email))</c>, so a row that
/// skipped this class cannot exist. <c>ux_app_user_email</c> is partial over non-null values,
/// because a worker need not have an address at all.
/// </para>
/// </summary>
public static class EmailAddress
{
    /// <summary>The RFC 5321 ceiling on a whole address. Enforced so a pathological value cannot
    /// reach a column that has no length limit of its own.</summary>
    public const int MaximumLength = 254;

    /// <summary>Exactly what the CHECK constraint asserts: <c>lower(btrim(...))</c>.</summary>
    public static string Normalise(string? input) =>
        (input ?? string.Empty).Trim().ToLowerInvariant();

    /// <summary>
    /// Deliberately a shape check and nothing more: one <c>@</c>, something either side, a dot in
    /// the domain, no whitespace, no control characters.
    /// <para>
    /// Chasing RFC 5322 in a regex is a well-known way to reject real addresses, and the only test
    /// that ever settles an address is whether mail reaches it. This exists to catch a typed
    /// mistake at the moment an admin can still fix it — not to be an authority on what an address
    /// is.
    /// </para>
    /// </summary>
    public static bool IsValid(string? email)
    {
        if (string.IsNullOrEmpty(email) || email.Length > MaximumLength)
        {
            return false;
        }

        var at = email.IndexOf('@', StringComparison.Ordinal);
        if (at <= 0 || at != email.LastIndexOf('@') || at == email.Length - 1)
        {
            return false;
        }

        foreach (var c in email)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c))
            {
                return false;
            }
        }

        var domain = email[(at + 1)..];

        return domain.Contains('.', StringComparison.Ordinal)
            && !domain.StartsWith('.')
            && !domain.EndsWith('.')
            && !domain.Contains("..", StringComparison.Ordinal);
    }

    /// <summary>Normalises and validates in one step, the way a handler wants it.</summary>
    public static bool TryNormalise(string? input, out string email)
    {
        email = Normalise(input);

        if (IsValid(email))
        {
            return true;
        }

        email = string.Empty;
        return false;
    }
}
