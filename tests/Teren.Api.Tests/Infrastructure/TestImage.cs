using System.IO.Compression;

namespace Teren.Api.Tests.Infrastructure;

/// <summary>
/// A real PNG, built by hand.
/// <para>
/// The report tests render with the **actual** QuestPDF renderer, which decodes what it is given
/// — so a photograph made of zero bytes would fail the layout for a reason that has nothing to do
/// with the behaviour under test, and stubbing the renderer out to avoid that would leave the
/// licence declaration, the Serbian glyph check and the whole layout untested behind a green
/// suite. QuestPDF carries its own native rasteriser rather than SkiaSharp, so there is no image
/// library on the test project's reference graph to borrow; forty lines of PNG is cheaper than
/// adding a dependency to a commercial product's build for the sake of test fixtures.
/// </para>
/// <para>
/// Deterministic per <c>index</c>, so a test can declare the real SHA-256 of what it stored and
/// tell one photograph from another.
/// </para>
/// </summary>
public static class TestImage
{
    private static readonly byte[] Signature = [137, 80, 78, 71, 13, 10, 26, 10];

    /// <summary>An 8-bit RGB PNG with a distinguishable pattern.</summary>
    public static byte[] Png(int index = 0, int width = 320, int height = 240)
    {
        var raw = new byte[height * (1 + (width * 3))];
        var offset = 0;

        for (var y = 0; y < height; y++)
        {
            // Filter type 0 (none) per scanline — the simplest thing every decoder handles.
            raw[offset++] = 0;

            for (var x = 0; x < width; x++)
            {
                // A soft diagonal wash, shifted per index, with a darker band across the middle
                // so a human looking at a sample report sees pictures rather than flat squares.
                var band = y > height * 0.55 && y < height * 0.72;
                raw[offset++] = (byte)(band ? 40 : 90 + ((x + (index * 40)) % 140));
                raw[offset++] = (byte)(band ? 70 : 120 + ((y + (index * 25)) % 110));
                raw[offset++] = (byte)(band ? 110 : 150 + ((x + y + (index * 60)) % 90));
            }
        }

        using var png = new MemoryStream();
        png.Write(Signature);

        var header = new byte[13];
        WriteInt32(header, 0, width);
        WriteInt32(header, 4, height);
        header[8] = 8;   // bit depth
        header[9] = 2;   // colour type: truecolour RGB
        header[10] = 0;  // deflate
        header[11] = 0;  // adaptive filtering
        header[12] = 0;  // no interlace

        WriteChunk(png, "IHDR", header);
        WriteChunk(png, "IDAT", Deflate(raw));
        WriteChunk(png, "IEND", []);

        return png.ToArray();
    }

    /// <summary>PNG's IDAT is a zlib stream (RFC 1950), which is exactly what ZLibStream writes —
    /// header and Adler-32 included.</summary>
    private static byte[] Deflate(byte[] data)
    {
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
        {
            zlib.Write(data);
        }

        return compressed.ToArray();
    }

    private static void WriteChunk(Stream target, string type, byte[] data)
    {
        var length = new byte[4];
        WriteInt32(length, 0, data.Length);
        target.Write(length);

        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        target.Write(typeBytes);
        target.Write(data);

        // The CRC covers the type and the data, never the length.
        var crc = Crc32([.. typeBytes, .. data]);
        var crcBytes = new byte[4];
        WriteInt32(crcBytes, 0, unchecked((int)crc));
        target.Write(crcBytes);
    }

    private static void WriteInt32(byte[] buffer, int offset, int value)
    {
        buffer[offset] = (byte)(value >> 24);
        buffer[offset + 1] = (byte)(value >> 16);
        buffer[offset + 2] = (byte)(value >> 8);
        buffer[offset + 3] = (byte)value;
    }

    private static readonly uint[] CrcTable = BuildCrcTable();

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++)
            {
                c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            }

            table[n] = c;
        }

        return table;
    }

    private static uint Crc32(byte[] data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data)
        {
            crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        }

        return crc ^ 0xFFFFFFFFu;
    }
}
