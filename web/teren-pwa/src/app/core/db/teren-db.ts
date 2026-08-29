import { InjectionToken } from '@angular/core';
import Dexie, { Table } from 'dexie';

import { AudioChunk, CaptureSession, LocalEntry, LocalMedia, OutboxItem } from './models';

export const TEREN_DB_NAME = 'teren';

/**
 * The local store. Three tables, exactly as ARCHITECTURE.md §11 prescribes: `entries`, `media`,
 * `outbox`.
 *
 * Schema versions are append-only: add a `.version(n).stores(...)` block, never edit an existing
 * one. A phone in the field may be several versions behind, and Dexie replays the chain.
 */
export class TerenDb extends Dexie {
  readonly entries!: Table<LocalEntry, string>;
  readonly media!: Table<LocalMedia, string>;
  readonly outbox!: Table<OutboxItem, string>;
  readonly chunks!: Table<AudioChunk, [string, number]>;
  readonly captures!: Table<CaptureSession, string>;

  constructor(name: string = TEREN_DB_NAME) {
    super(name);

    // v1 — B2 (capture flow, offline only).
    this.version(1).stores({
      // `localDay` answers "has today's entry been recorded?"; `[projectId+capturedAt]` drives
      // the per-project recent list without sorting the whole table in memory.
      entries: 'id, projectId, capturedAt, status, localDay, [projectId+capturedAt]',
      // `[entryId+kind]` fetches "the audio of this entry" and "the photos of this entry".
      media: 'id, entryId, kind, [entryId+kind], uploadState',
      // `seq` gives the sync loop its FIFO order.
      outbox: 'entryId, state, seq, nextAttemptAt',
    });

    // v2 — B2: audio is written to disk while it is still being recorded, not only at stop.
    this.version(2).stores({
      // Compound primary key: writing the same slice twice cannot duplicate it.
      chunks: '[entryId+seq], entryId',
      captures: 'entryId, updatedAt',
    });
  }
}

/**
 * One connection per application. A second connection to the same database would fight the first
 * over version upgrades; tests override this token with their own throwaway database instead.
 */
export const TEREN_DB = new InjectionToken<TerenDb>('TEREN_DB', {
  providedIn: 'root',
  factory: () => new TerenDb(),
});
