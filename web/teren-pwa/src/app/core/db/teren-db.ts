import { InjectionToken } from '@angular/core';
import Dexie, { Table } from 'dexie';

import { canonicalProject } from '../projects/legacy-project-ids';
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

    // v3 — B3: the demo project ids were corrected to the ones the seeder really creates.
    //
    // No schema change: `stores({})` declares no table changes and exists only to hang the data
    // migration on. Anything captured during B2 carries an id the server has never heard of, and
    // `POST /api/entries` rejects those with a `404` that no amount of retrying resolves — so the
    // rows are moved onto the real ids here, before the outbox ever picks them up.
    //
    // Dexie runs this only when opening a database that is actually below v3; a database created
    // fresh at v3 skips it, and it cannot run twice on the same device.
    this.version(3)
      .stores({})
      .upgrade(async (tx) => {
        // The only two tables that name a site. Media, chunks and outbox rows reference their
        // entry, never the project, so they follow the entry without being touched.
        await remapLegacyProjectIds(tx.table('entries'));
        await remapLegacyProjectIds(tx.table('captures'));
      });

    // v4 — B3: the upload path. `media` rows gain `sha256`, `outbox` rows gain `failureKind`,
    // and `outbox.state` gains the value `blocked`.
    //
    // **No `.upgrade()`, deliberately, and no index on the new fields.** Two decisions worth
    // stating rather than leaving to be inferred:
    //
    // 1. *Why the version exists at all.* Dexie stores undeclared properties without being told
    //    about them, so strictly speaking none of the three additions requires a version block.
    //    It is declared anyway because `verno` is the only durable record of when the on-disk
    //    shape changed: a future migration (C1's pruning, a re-hash after a checksum bug) needs
    //    to be able to say "rows written below v4 carry no sha256" without guessing. A schema
    //    marker costs one IndexedDB version bump; reconstructing that fact later costs a
    //    heuristic that is wrong on somebody's phone.
    //
    // 2. *Why nothing is backfilled here.* The obvious alternative is to hash every existing
    //    media blob in the upgrade. That would read every recording and photo on the device
    //    through `crypto.subtle` **before `db.open()` resolves**, which is before the first
    //    screen renders — on a phone with a week of unsent entries the app would appear to hang
    //    on launch, for work that is only needed by the one entry the outbox is about to send.
    //    Worse, it would run in the one place where failure is least recoverable: an upgrade
    //    that throws leaves the database unopenable, and `crypto.subtle` is absent on any origin
    //    that is not a secure context (see `sync/sha256.ts`) — so a foreman on a plain-http
    //    tunnel would lose the whole local store rather than one upload.
    //
    //    So hashes are computed lazily, at the first upload attempt, and persisted. The cost is
    //    paid per file, once, off the critical path, by the code that already has to handle
    //    `crypto.subtle` being missing.
    this.version(4).stores({});
  }
}

/** A row that names the site it belongs to — `entries` and `captures` carry the same two fields. */
interface ProjectScopedRow {
  projectId: string;
  projectName: string;
}

/**
 * Move every row captured under a pre-B3 demo project id onto the id the server seeds.
 *
 * Rows already on a canonical id, and rows whose project this build does not know, are left
 * exactly as they are — so this is safe on an empty database, safe on a mixed one, and a no-op if
 * it ever runs again.
 */
async function remapLegacyProjectIds(table: Table<ProjectScopedRow, unknown>): Promise<void> {
  await table.toCollection().modify((row) => {
    const canonical = canonicalProject(row.projectId);
    if (!canonical || canonical.id === row.projectId) {
      return;
    }
    row.projectId = canonical.id;
    // `projectName` is denormalised onto the row, so it moves with the id it describes rather
    // than being left to name a project the row no longer belongs to.
    row.projectName = canonical.name;
  });
}

/**
 * One connection per application. A second connection to the same database would fight the first
 * over version upgrades; tests override this token with their own throwaway database instead.
 */
export const TEREN_DB = new InjectionToken<TerenDb>('TEREN_DB', {
  providedIn: 'root',
  factory: () => new TerenDb(),
});
