using System.Buffers.Text;
using System.Globalization;
using System.Text;

namespace Teren.Api.Platform;

/// <summary>
/// The cursor the log stream pages by: <c>(at DESC, id DESC)</c>.
///
/// <para>
/// <b>A separate type from <see cref="Keyset"/> because the key is a different shape</b> — a
/// <c>bigserial</c> rather than a uuid — and a cursor that decoded a long as a guid would either
/// throw or, worse, page from a position that does not exist. Everything else is deliberately the
/// same: base64url over <c>"&lt;ticks&gt;:&lt;id&gt;"</c>, opaque to the caller, and a malformed
/// value is a <b>400</b> rather than a silent reset to the first page.
/// </para>
///
/// <para>
/// <b>Keyset matters more here than anywhere else in the product.</b> The other platform lists page
/// over tables that change a few times a day; this one pages over a firehose. With
/// <c>OFFSET 50</c>, a hundred lines arriving while an operator reads page one means page two
/// starts fifty rows above where he left off — he re-reads what he has seen and never sees what
/// he skipped, and nothing about the screen tells him so.
/// </para>
///
/// <para>
/// The id is not decoration: <c>at</c> is not unique — a batch of log rows written in one flush
/// share a millisecond routinely — and a keyset over a non-unique key either skips rows or repeats
/// them forever.
/// </para>
/// </summary>
public readonly record struct LogKeyset(DateTime At, long Id)
{
    public string Encode()
    {
        var raw = string.Create(
            CultureInfo.InvariantCulture, $"{At.Ticks}:{Id}");

        return Base64Url.EncodeToString(Encoding.UTF8.GetBytes(raw));
    }

    /// <summary>
    /// Read a cursor, or fail. Every malformed shape lands on <c>false</c> — bad base64, a missing
    /// separator, a tick count or an id that is not a number — because the caller has no use for
    /// the difference and a parser that threw would turn a typo into a 500.
    /// </summary>
    public static bool TryDecode(string? cursor, out LogKeyset keyset)
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

        if (!long.TryParse(raw.AsSpan(0, separator), CultureInfo.InvariantCulture, out var ticks)
            || ticks < 0
            || ticks > DateTime.MaxValue.Ticks)
        {
            return false;
        }

        if (!long.TryParse(raw.AsSpan(separator + 1), CultureInfo.InvariantCulture, out var id))
        {
            return false;
        }

        // Kind matters: every timestamp in this product is UTC, and a cursor that decoded to
        // `Unspecified` would compare against a timestamptz column through Npgsql's conversion and
        // page from the wrong instant on any machine that is not on UTC.
        keyset = new LogKeyset(new DateTime(ticks, DateTimeKind.Utc), id);
        return true;
    }
}
