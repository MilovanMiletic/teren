namespace Teren.Core.Time;

/// <summary>
/// A stored timestamp turned into something safe to put on the wire.
///
/// <para>
/// <b>The bug this exists to prevent.</b> Npgsql hands back a <see cref="DateTime"/> of
/// <see cref="DateTimeKind.Unspecified"/> for a <c>timestamptz</c> column. Serialised as-is that
/// becomes a stamp with no offset, and every browser reads an offsetless stamp as <em>local</em>
/// time — so a report sent at 07:00 UTC shows as 09:00 to a Belgrade reader and as 02:00 to one in
/// New York, silently, with nothing in the payload to say which is meant. Stamping the kind before
/// widening to <see cref="DateTimeOffset"/> is what puts the <c>Z</c> back on.
/// </para>
///
/// <para>
/// It lived as a copied pair of private helpers in four files — two endpoint groups, the platform
/// directory and the reporter. Four copies of a two-line conversion is not a maintenance cost worth
/// mentioning; four places where somebody can write the correct-looking version <em>without</em>
/// the <c>SpecifyKind</c> is, because that version compiles, passes every test that does not read
/// the wire format, and is wrong by hours.
/// </para>
/// </summary>
public static class UtcStamp
{
    /// <summary>A stored UTC stamp as an offset-carrying instant.</summary>
    public static DateTimeOffset Of(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    /// <summary>The same, for a column that may be null.</summary>
    public static DateTimeOffset? OrNull(DateTime? value) =>
        value is null ? null : Of(value.Value);
}
