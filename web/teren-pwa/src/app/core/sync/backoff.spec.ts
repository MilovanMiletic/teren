import { BASE_DELAY_MS, MAX_DELAY_MS, backoffMs, nextAttemptAt } from './backoff';

describe('backoff', () => {
  /** No jitter, so the spec asserts on the schedule rather than on a random draw. */
  const centre = () => 0.5;

  it('doubles the wait with each failed attempt', () => {
    expect(backoffMs(1, centre)).toBe(BASE_DELAY_MS);
    expect(backoffMs(2, centre)).toBe(BASE_DELAY_MS * 2);
    expect(backoffMs(3, centre)).toBe(BASE_DELAY_MS * 4);
    expect(backoffMs(4, centre)).toBe(BASE_DELAY_MS * 8);
  });

  it('stops doubling at the ceiling, so a long outage never means a long silence', () => {
    // Without a cap the twentieth attempt would be scheduled for a fortnight away, and a phone
    // that came back into coverage would sit on unsent evidence until the app was reopened.
    expect(backoffMs(20, centre)).toBe(MAX_DELAY_MS);
    expect(backoffMs(200, centre)).toBe(MAX_DELAY_MS);
  });

  it('spreads retries either side of the interval rather than only later', () => {
    const earliest = backoffMs(4, () => 0);
    const latest = backoffMs(4, () => 1);
    const centred = backoffMs(4, centre);

    expect(earliest).toBeLessThan(centred);
    expect(latest).toBeGreaterThan(centred);
    // ±30%: enough to break lockstep between phones on one site's Wi-Fi, not so much that the
    // first retry after a blip feels slow.
    expect(earliest).toBe(Math.round(centred * 0.7));
    expect(latest).toBe(Math.round(centred * 1.3));
  });

  it('never schedules an attempt in the past or immediately', () => {
    for (let attempts = 1; attempts <= 30; attempts += 1) {
      expect(backoffMs(attempts, () => 0)).toBeGreaterThanOrEqual(BASE_DELAY_MS / 2);
    }
  });

  it('renders the due time as an ISO instant the outbox can compare as a string', () => {
    const at = nextAttemptAt(1, Date.parse('2026-08-29T10:00:00.000Z'), centre);

    expect(at).toBe('2026-08-29T10:00:05.000Z');
  });
});
