/**
 * Let Dexie's `liveQuery` deliver.
 *
 * A live query runs its read on a real IndexedDB transaction and emits on a later task, so
 * `fixture.whenStable()` — which only knows about Angular's own pending work — can return before
 * the store has answered. Specs that assert on data read from Dexie wait here first.
 */
export async function flushLiveQueries(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wait for a condition the code under test actually reaches, rather than for a fixed number of
 * turns.
 *
 * A count of `flushLiveQueries` turns is a guess at how many tasks a chain of IndexedDB
 * transactions will take, and a guess that is right on an idle machine is wrong on a loaded one —
 * the spec then fails for a reason that has nothing to do with the code. Where a spec is waiting
 * for something to *finish*, wait for the thing itself.
 *
 * `onTick` runs before every check, so a caller can drive change detection while polling.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; onTick?: () => void; describe?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    options.onTick?.();
    if (await condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${options.describe ?? 'condition'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
