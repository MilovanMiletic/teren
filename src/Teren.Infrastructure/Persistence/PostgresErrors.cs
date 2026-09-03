using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Teren.Infrastructure.Persistence;

/// <summary>
/// Reading a Postgres error out of an EF exception, in one place.
///
/// <para>
/// <b>Why this is worth a type.</b> Four handlers had written the same three lines — unwrap
/// <see cref="DbUpdateException.InnerException"/>, check the SQLSTATE, compare the constraint name
/// — and one of them had the SQLSTATE as the bare literal <c>"23505"</c> rather than as
/// <see cref="PostgresErrorCodes.UniqueViolation"/>. Four copies is four chances to get it subtly
/// wrong, and each of them sits on the path where a lost insert race becomes either a clean 409 or
/// a 500 in a customer's face.
/// </para>
///
/// <para>
/// <b>The constraint name is matched exactly and is never optional.</b> A handler that caught "any
/// unique violation" would turn an unrelated constraint — one added later, on a column the handler
/// has never heard of — into a confident, specific and wrong answer. Naming the constraint is what
/// keeps the <c>catch</c> honest: an unexpected violation stays an unhandled 500, which is visible,
/// rather than a 409 that lies about which row was the duplicate.
/// </para>
/// </summary>
public static class PostgresErrors
{
    /// <summary>
    /// True when this EF failure is Postgres refusing an insert or update because of the named
    /// unique index or constraint.
    /// </summary>
    public static bool IsUniqueViolation(DbUpdateException? exception, string constraintName) =>
        exception?.InnerException is PostgresException
            { SqlState: PostgresErrorCodes.UniqueViolation } pg
        && string.Equals(pg.ConstraintName, constraintName, StringComparison.Ordinal);
}
