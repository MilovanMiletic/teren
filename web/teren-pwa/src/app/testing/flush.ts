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
