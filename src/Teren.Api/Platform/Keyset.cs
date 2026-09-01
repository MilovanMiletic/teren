using System.Buffers.Text;
using System.Globalization;
using System.Text;

namespace Teren.Api.Platform;

/// <summary>
/// The opaque cursor the platform lists page by, and the ordering it pages along.
///
/// <para>
/// <b>Keyset, not offset, and the reason is a real one rather than a performance slogan</b>
/// (plan §8). A founder scrolling the user list while a customer signs up is the ordinary case,
/// not an edge case: with <c>OFFSET 50</c> a row inserted above the window shifts everything down
/// one, so page 2 re-shows the last row of page 1 and the row that should have been first is never
/// seen at all. Paging *from a row* instead of *from a count* is immune to that — the next page is
/// defined relative to something that exists, so an insert above the window changes nothing about
/// what comes next.
/// </para>
///
/// <para>
/// The sort is <c>(created_at DESC, id DESC)</c>. The id is not decoration: <c>created_at</c> is
/// not unique — a seeded company and its admin are written in the same transaction and can share a
/// timestamp to the microsecond — and a keyset over a non-unique key either skips rows or repeats
/// them forever. The id breaks every tie and is the reason this is correct rather than
/// nearly-correct.
/// </para>
///
/// <para>
/// <b>Opaque on purpose.</b> The value is base64url over "&lt;ticks&gt;:&lt;guid&gt;" — readable
/// by anyone who cares to look, which is fine, since it encodes only the position of a row the
/// caller was just shown. Opacity here buys the freedom to change the sort later without every
/// client having to agree, and it stops a caller hand-crafting a cursor that pages a different way
/// than the query is indexed for. A malformed cursor is a <b>400</b>, never a silent reset to the
/// first page: the second is how a client loops forever over page one and nobody notices.
/// </para>
/// </summary>
public readonly record struct Keyset(DateTime CreatedAt, Guid Id)
{
    /// <summary>
    /// How many rows a page carries when the caller does not say, and the ceiling when he does.
    /// <para>
    /// A ceiling exists because <c>limit</c> is caller-controlled and this surface can enumerate
    /// every account in the product; without one, "give me everything" is a single request. 200 is
    /// the same generous-but-bounded figure the archive list uses.
    /// </para>
    /// </summary>
    public const int DefaultLimit = 50;

    public const int MaxLimit = 200;

    /// <summary>
    /// Clamp a caller's requested page size. A nonsensical value is corrected rather than refused —
    /// unlike a bad cursor, there is no ambiguity about what was meant, and a 400 over
    /// <c>?limit=0</c> teaches a client nothing it could not be told by simply working.
    /// </summary>
    public static int Limit(int? requested) => requested switch
    {
        null or <= 0 => DefaultLimit,
        > MaxLimit => MaxLimit,
        _ => requested.Value,
    };

    /// <summary>The cursor a caller sends back to continue after this row.</summary>
    public string Encode()
    {
        var raw = $"{CreatedAt.Ticks.ToString(CultureInfo.InvariantCulture)}:{Id:N}";
        return Base64Url.EncodeToString(Encoding.UTF8.GetBytes(raw));
    }

    /// <summary>
    /// Read a cursor, or fail. Every malformed shape lands on <c>false</c> — bad base64, a missing
    /// separator, a tick count that is not a number, a guid that is not one — because a caller has
    /// no use for the difference and a parser that threw would turn a typo into a 500.
    /// </summary>
    public static bool TryDecode(string? cursor, out Keyset keyset)
    {
        keyset = default;

        if (string.IsNullOrWhiteSpace(cursor))
        {
            return false;
        }

        byte[] bytes;
        try
        {
            bytes = Base64Url.DecodeFromChars(cursor);
        }
        catch (FormatException)
        {
            return false;
        }

        var raw = Encoding.UTF8.GetString(bytes);
        var separator = raw.IndexOf(':');
        if (separator <= 0 || separator == raw.Length - 1)
        {
            return false;
        }

        if (!long.TryParse(
                raw.AsSpan(0, separator), CultureInfo.InvariantCulture, out var ticks)
            || ticks < 0
            || ticks > DateTime.MaxValue.Ticks)
        {
            return false;
        }

        if (!Guid.TryParseExact(raw.AsSpan(separator + 1), "N", out var id))
        {
            return false;
        }

        // Kind matters: every timestamp in this product is UTC, and a cursor that decoded to
        // `Unspecified` would compare against a UTC column through Npgsql's conversion and page
        // from the wrong instant on any machine that is not on UTC.
        keyset = new Keyset(new DateTime(ticks, DateTimeKind.Utc), id);
        return true;
    }
}
