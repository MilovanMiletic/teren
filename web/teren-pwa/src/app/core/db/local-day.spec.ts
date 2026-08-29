import { dayLabel, localDay } from './local-day';

describe('localDay', () => {
  it('uses the local calendar day, not UTC', () => {
    // 00:30 on the 30th in Belgrade is still 22:30 on the 29th in UTC. A UTC-based day would
    // file this entry under the wrong date and the home screen would claim today was not
    // recorded.
    const justAfterMidnight = new Date(2026, 7, 30, 0, 30, 0);
    expect(localDay(justAfterMidnight)).toBe('2026-08-30');
  });

  it('pads month and day', () => {
    expect(localDay(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
  });
});

describe('dayLabel', () => {
  const today = '2026-08-29';

  it('recognises today', () => {
    expect(dayLabel(new Date(2026, 7, 29, 14, 5).toISOString(), today)).toBe('today');
  });

  it('recognises yesterday', () => {
    expect(dayLabel(new Date(2026, 7, 28, 16, 52).toISOString(), today)).toBe('yesterday');
  });

  it('crosses a month boundary backwards', () => {
    expect(dayLabel(new Date(2026, 6, 31, 8, 0).toISOString(), '2026-08-01')).toBe('yesterday');
  });

  it('falls back to a plain date', () => {
    expect(dayLabel(new Date(2026, 7, 26, 9, 0).toISOString(), today)).toBe('other');
  });
});
