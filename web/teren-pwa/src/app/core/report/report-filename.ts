/**
 * What the saved file is called.
 *
 * The server names the report — a human-readable Serbian filename in the project's language, not
 * the phone's (`PROJECT.md` §11: the report is the *client's* document) — and sends it on
 * `Content-Disposition`. This module's whole job is to get that name out of the header safely, or
 * to admit it could not and fall back to something neutral.
 *
 * **The browser may simply refuse to show us the header.** `Content-Disposition` is not a
 * CORS-safelisted response header, so when the PWA and the API are on different origins — which
 * is every development setup here, `localhost:4200` against `localhost:5080` — it is readable
 * only if the server also sends `Access-Control-Expose-Headers: Content-Disposition`. A missing
 * header is therefore an ordinary, expected outcome and not a failure: the download still
 * succeeds, and the file gets the fallback name.
 */

/** `filename*=UTF-8''Teren%20-%20izve%C5%A1taj.pdf` — RFC 5987, the form that carries č/ć/š/ž/đ. */
const EXTENDED = /filename\*\s*=\s*([^;]+)/i;

/** `filename="Teren - izvestaj.pdf"`, escapes included. */
const QUOTED = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i;

/** `filename=izvestaj.pdf` — unquoted, so it ends at the first separator. */
const PLAIN = /filename\s*=\s*([^;]+)/i;

/** Control characters. A newline or a NUL in a filename is a name to be cleaned up, not trusted. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f]/g;

/** Long enough for "Teren - Vojvode Stepe 212 - 29.08.2026.pdf", short of any filesystem limit. */
const MAX_LENGTH = 120;

/**
 * Read the server's filename out of a `Content-Disposition` header.
 *
 * Returns `null` for a header that is absent, unreadable, or carries no filename at all — every
 * one of which means the same thing to the caller: name the file yourself.
 *
 * The extended form wins over the plain one when both are present, which is what RFC 6266 says
 * and also the only one of the two that can carry Serbian diacritics.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }

  const extended = EXTENDED.exec(header);
  if (extended) {
    const decoded = decodeExtended(extended[1].trim());
    if (decoded) {
      return decoded;
    }
    // A malformed `filename*` is not a reason to give up: RFC 6266 senders include a plain
    // `filename` beside it precisely so an old client still gets a name.
  }

  const quoted = QUOTED.exec(header);
  if (quoted) {
    return unescape(quoted[1]) || null;
  }

  const plain = PLAIN.exec(header);
  return plain ? plain[1].trim() || null : null;
}

/**
 * Make a name the browser can be handed, or use the fallback.
 *
 * Two things are being defended against, and the first is not paranoia about a hostile server:
 * `Content-Disposition` reaches us as a string and `<a download>` writes a file, so any path
 * separator in it is a name that means something other than what it looks like. Everything after
 * the last separator is kept and the rest is dropped, which is what a browser's own download
 * logic does.
 *
 * The second is duller: a name with no extension on it opens in nothing on Windows and in a text
 * viewer on Android. The extension is enforced rather than trusted.
 */
export function safeFilename(
  raw: string | null | undefined,
  fallbackBase: string,
  /**
   * What the file must end in, without the dot.
   *
   * Defaulted to `pdf` because the report is what this module was written for and every existing
   * call site means that. The log export (D5) is a CSV and passes `csv` — one parameter rather
   * than a second copy of the whole sanitiser, because everything else about naming a downloaded
   * file is identical and the traversal defence below is exactly the part nobody should write
   * twice.
   */
  extension: string = 'pdf',
): string {
  const lastSegment = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment
    .replace(UNSAFE, '')
    // A leading dot hides the file on Unix-like systems, and `..` is a name no download needs.
    .replace(/^\.+/, '')
    .trim();

  const base = withoutExtension(cleaned.length > 0 ? cleaned : fallbackBase, extension)
    .slice(0, MAX_LENGTH)
    .trim();
  return `${base.length > 0 ? base : fallbackBase}.${extension}`;
}

/** Strip a trailing extension so the length cap cannot cut it in half. */
function withoutExtension(name: string, extension: string): string {
  return name.replace(new RegExp(`\\.${extension}$`, 'i'), '');
}

/**
 * `UTF-8''<percent-encoded>` — and only that charset.
 *
 * `iso-8859-1` cannot spell a single Serbian diacritic, so a server sending it has already lost
 * the name; decoding it as if it were UTF-8 would produce mojibake, which is worse than falling
 * back to a plain neutral filename.
 */
function decodeExtended(value: string): string | null {
  const parts = value.split("''");
  if (parts.length < 2 || !/^utf-8$/i.test(parts[0].trim())) {
    return null;
  }
  try {
    return decodeURIComponent(parts.slice(1).join("''")) || null;
  } catch {
    // Percent-encoding the server got wrong. Not worth a failed download.
    return null;
  }
}

/** Undo the backslash escapes a quoted-string may carry. */
function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1').trim();
}
