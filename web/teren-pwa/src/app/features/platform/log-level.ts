/**
 * The six Serilog levels and the four time ranges the log screen offers, kept out of the component
 * so both can be walked by a spec.
 *
 * The levels are **wire values** — they go into the `level` query parameter exactly as the server
 * stores them, and they are never translated on the way out. What *is* translated is the word on
 * the chip, which is why `logs.level.<lowercase>` exists in both dictionaries and why
 * `i18n.spec.ts` walks this list: a level with no Serbian word behind it would put `Verbose` on a
 * chip beside `Greška`, on a screen a Serbian founder reads.
 */

/** In increasing severity, which is the order the chips are drawn in. */
export const LOG_LEVELS = [
  'Verbose',
  'Debug',
  'Information',
  'Warning',
  'Error',
  'Fatal',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The chip tones this product already has (`styles.css` §Status chips). */
export type LogTone = 'ok' | 'warn' | 'err' | 'neutral';

/**
 * How alarmed to look.
 *
 * `Fatal` and `Error` are the red pair; `Warning` is amber; everything below is neutral, including
 * `Information` — a green chip on every second row would make the two colours that matter
 * invisible, which is the whole failure mode of a coloured log.
 *
 * A level this build has never heard of is neutral rather than dropped: a newer server must be
 * able to add one without an older console refusing to draw the row.
 */
export function levelTone(level: string): LogTone {
  switch (level) {
    case 'Fatal':
    case 'Error':
      return 'err';
    case 'Warning':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** The word behind a level chip. Lower-cased, because a dictionary key is not a wire value. */
export function levelKey(level: string): string {
  const known = (LOG_LEVELS as readonly string[]).includes(level);
  // An unknown level prints as itself rather than as a raw missing key — see `LogsPage.levelWord`.
  return known ? `logs.level.${level.toLowerCase()}` : '';
}

/**
 * How far back to look.
 *
 * Presets rather than two date fields, and the reason is not only that a date picker is a control
 * this product does not own: **`<input type="date">` renders the operating system's own calendar**
 * — square corners, a system-blue header, the system font — which is exactly why this app draws
 * its own dropdown instead of a `<select>` (`ui/select-field.ts`). It is also the wrong shape for
 * the question: a log is read in relative time ("what happened just now", "what happened today"),
 * and retention is fourteen days, so `all` is already a bounded range.
 */
export const LOG_RANGES = ['hour', 'today', 'week', 'all'] as const;

export type LogRange = (typeof LOG_RANGES)[number];

/**
 * The `from` instant a range means, or `null` for "everything the server still has".
 *
 * `today` is the **local** midnight, not UTC's: a founder in Belgrade asking for today means the
 * day he is standing in, and a UTC boundary would silently drop two hours of his evening in summer
 * time. `now` is a parameter so this is a pure function with a spec rather than a clock.
 */
export function fromFor(range: LogRange, now: Date): string | null {
  switch (range) {
    case 'hour':
      return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    case 'today': {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return midnight.toISOString();
    }
    case 'week':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case 'all':
      return null;
  }
}
