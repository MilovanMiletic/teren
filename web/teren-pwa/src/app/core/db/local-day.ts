/**
 * The local calendar day of a moment, as `YYYY-MM-DD`.
 *
 * Built from the local date parts rather than `toISOString()`, which would silently answer in UTC
 * and put a 01:30 entry in Belgrade on the previous day. "Is there an entry for today?" is the
 * home screen's headline, so it has to mean the foreman's today.
 */
export function localDay(moment: Date): string {
  const year = moment.getFullYear();
  const month = `${moment.getMonth() + 1}`.padStart(2, '0');
  const day = `${moment.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export type DayLabel = 'today' | 'yesterday' | 'other';

/**
 * How a moment should be named relative to the day the app currently believes it is: "Danas",
 * "Juče", or a plain date. `today` is passed in rather than read from the clock so the caller's
 * notion of today (which survives a phone left on overnight) stays the only one.
 */
export function dayLabel(iso: string, today: string): DayLabel {
  const day = localDay(new Date(iso));
  if (day === today) {
    return 'today';
  }
  const yesterday = new Date(`${today}T00:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  return day === localDay(yesterday) ? 'yesterday' : 'other';
}
