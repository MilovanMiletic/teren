/** First retry delay. Short enough that a momentary blip is invisible to the foreman. */
export const BASE_DELAY_MS = 5_000;

/**
 * Ceiling on the retry interval.
 *
 * There is no attempt cap for a genuinely retryable failure — a phone that spends a weekend out
 * of coverage must still send on Monday, and giving up would strand evidence. What bounds the
 * cost instead is this ceiling: once the delay reaches ten minutes the loop wakes six times an
 * hour, which is nothing against the screen the foreman is already carrying. Failures that are
 * *not* about the far end being unavailable are bounded differently, by escalation to `stuck`
 * (see `api-failure.ts`).
 */
export const MAX_DELAY_MS = 10 * 60_000;

/** Proportion of the delay that is randomised. */
const JITTER = 0.3;

/**
 * Exponential backoff with jitter (ARCHITECTURE §11).
 *
 * The jitter matters more than it looks: when a site's Wi-Fi comes back, every phone on it
 * retries at once. Without it, several devices with the same failure history would keep
 * requesting in lockstep for as long as the outage lasted, converting one outage into a
 * self-inflicted one. Applied ± around the delay rather than only upward, so the average
 * interval is the interval.
 *
 * @param attempts how many attempts have already failed, including the one that just did
 * @param random   injectable for the specs; defaults to `Math.random`
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  const jitter = delay * JITTER * (random() * 2 - 1);
  return Math.max(BASE_DELAY_MS / 2, Math.round(delay + jitter));
}

/** The ISO instant the next attempt becomes due. */
export function nextAttemptAt(
  attempts: number,
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  return new Date(now + backoffMs(attempts, random)).toISOString();
}
