import { filenameFromContentDisposition, safeFilename } from './report-filename';

/**
 * The name the report is saved under.
 *
 * Worth its own suite for two unrelated reasons. The first is Serbian: the server sends a
 * human-readable filename in the project's language, which means č, ć, š, ž and đ, which means
 * the RFC 5987 `filename*` form — get the decoding wrong and every report on the phone is called
 * `Teren â izveÅ¡taj.pdf`. The second is that this string comes off the network and is then used
 * to name a file on disk.
 */
describe('filenameFromContentDisposition', () => {
  it('decodes the extended form, which is the only one that can spell Serbian', () => {
    const header = "attachment; filename*=UTF-8''Teren%20-%20izve%C5%A1taj%20-%2029.08.2026.pdf";
    expect(filenameFromContentDisposition(header)).toBe('Teren - izveštaj - 29.08.2026.pdf');
  });

  it('prefers the extended form over the ASCII fallback beside it', () => {
    // RFC 6266 senders write both. Taking the plain one would silently drop the diacritics that
    // the extended one exists to carry.
    const header =
      'attachment; filename="Teren - izvestaj.pdf"; ' +
      "filename*=UTF-8''Teren%20-%20izve%C5%A1taj.pdf";
    expect(filenameFromContentDisposition(header)).toBe('Teren - izveštaj.pdf');
  });

  it('falls back to the plain form when the extended one is malformed', () => {
    // A broken `filename*` is exactly why the sender wrote a plain one too.
    const header = 'attachment; filename="izvestaj.pdf"; filename*=UTF-8\'\'%E0%A4%A';
    expect(filenameFromContentDisposition(header)).toBe('izvestaj.pdf');
  });

  it('refuses a charset it cannot honestly decode', () => {
    // Decoding latin-1 bytes as UTF-8 produces mojibake, which is worse than no name at all.
    expect(filenameFromContentDisposition("attachment; filename*=iso-8859-1''izvestaj.pdf")).toBe(
      null,
    );
  });

  it('reads the unquoted form', () => {
    expect(filenameFromContentDisposition('attachment; filename=izvestaj.pdf')).toBe(
      'izvestaj.pdf',
    );
  });

  it('answers null when the browser would not show us the header at all', () => {
    // The ordinary cross-origin case: not CORS-safelisted, so absent unless the server exposes
    // it. A download with no name is still a download.
    expect(filenameFromContentDisposition(null)).toBe(null);
    expect(filenameFromContentDisposition('attachment')).toBe(null);
  });
});

describe('safeFilename', () => {
  it('keeps the server name it was given', () => {
    expect(safeFilename('Teren - izveštaj - 29.08.2026.pdf', 'teren-2026-08-29')).toBe(
      'Teren - izveštaj - 29.08.2026.pdf',
    );
  });

  it('uses the fallback when there is no readable name', () => {
    expect(safeFilename(null, 'teren-2026-08-29')).toBe('teren-2026-08-29.pdf');
    expect(safeFilename('   ', 'teren-2026-08-29')).toBe('teren-2026-08-29.pdf');
  });

  it('keeps only the last path segment', () => {
    // The header is a string off the network and `<a download>` writes a file. A name that
    // carries separators is a name that means something other than it looks like.
    expect(safeFilename('../../etc/passwd', 'teren')).toBe('passwd.pdf');
    expect(safeFilename('C:\\Windows\\system32\\report.pdf', 'teren')).toBe('report.pdf');
  });

  it('refuses a name that is nothing but dots', () => {
    expect(safeFilename('..', 'teren-2026-08-29')).toBe('teren-2026-08-29.pdf');
  });

  it('always ends in .pdf, and never twice', () => {
    expect(safeFilename('izvestaj', 'teren')).toBe('izvestaj.pdf');
    expect(safeFilename('izvestaj.PDF', 'teren')).toBe('izvestaj.pdf');
  });

  it('caps the length without cutting the extension in half', () => {
    const saved = safeFilename(`${'a'.repeat(400)}.pdf`, 'teren');
    expect(saved.endsWith('.pdf')).toBe(true);
    expect(saved.length).toBeLessThanOrEqual(124);
  });
});
