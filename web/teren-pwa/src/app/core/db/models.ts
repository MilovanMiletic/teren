/**
 * The local (phone) data model.
 *
 * PROJECT.md principle 3: the phone is the source of truth until the server confirms receipt.
 * Everything captured lands here first, keyed by a UUID the device generates at capture time,
 * and nothing is ever deleted locally before the server has confirmed it (in B2, nothing is
 * deleted at all).
 *
 * ARCHITECTURE.md §6 is explicit that the phone-side and server-side state vocabularies are
 * deliberately different; conflating them is how sync bugs are born. They are therefore two
 * separate fields on the entry, never one.
 */

/** Phone-side lifecycle (ARCHITECTURE.md §6 "phone:" row). */
export type LocalEntryStatus =
  /** Being captured right now; not yet a complete unit of work. */
  | 'draft'
  /** Complete and waiting for the network. The only state B2 ever hands to the outbox. */
  | 'queued'
  /** A sync attempt is in flight (B3 sets this). */
  | 'uploading'
  /**
   * The last sync attempt failed and will be retried (B3 sets this). A retryable sub-state of
   * `queued`, not a terminal one: the entry stays in the outbox and nothing is discarded.
   */
  | 'failed'
  /**
   * The server gave an answer that will not change (B3 sets this): the project is unknown, the
   * declaration was refused, this device is not authorised, this origin cannot hash. The entry is
   * **not lost** — every byte is still on the phone — but no amount of retrying will move it, so
   * the loop stops and the pending screen says so out loud. Only an explicit "try again" (or a
   * new build that fixes the cause) puts it back in the queue.
   */
  | 'blocked'
  /** The server acknowledged receipt. Only now may local media eventually be pruned. */
  | 'confirmed_by_server';

/** Server-side lifecycle as last reported by the API (ARCHITECTURE.md §6 "server:" row). */
export type ServerEntryStatus =
  'received' | 'processing' | 'awaiting_confirmation' | 'needs_review' | 'confirmed' | 'reported';

export type MediaKind = 'audio' | 'photo';

/** Per-file upload state, so B3 can resume a partly-uploaded entry file by file. */
export type MediaUploadState = 'pending' | 'uploading' | 'uploaded';

/** A position fix, read from the Geolocation API — web capture carries no EXIF. */
export interface GeoFix {
  latitude: number;
  longitude: number;
  /** Metres, as reported by the platform. */
  accuracyM: number | null;
  /** When the platform took the fix, ISO-8601. */
  fixedAt: string;
}

export interface LocalEntry {
  /** `crypto.randomUUID()`, generated on the device at capture time. The idempotency key. */
  id: string;
  projectId: string;
  /** Denormalised so an entry always renders, even if the project list changes underneath it. */
  projectName: string;
  /** When capture started, ISO-8601. */
  capturedAt: string;
  /**
   * Local calendar day of `capturedAt` as `YYYY-MM-DD`. Indexed, because "is there an entry for
   * today?" is the home screen's headline question and must not scan the table.
   */
  localDay: string;
  status: LocalEntryStatus;
  /** Null until the server has told us something (B3+). */
  serverStatus: ServerEntryStatus | null;
  /** Where the phone was when recording started. Attached to the entry, per ARCHITECTURE.md §5. */
  geo: GeoFix | null;
  /** Recording length in milliseconds, for the pending/recent rows. */
  audioDurationMs: number;
  /** Maintained alongside the media rows so list screens need no per-row join. */
  photoCount: number;
  /** Set by B3 when the server confirms receipt. */
  confirmedByServerAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalMedia {
  /** `crypto.randomUUID()`, generated on the device. */
  id: string;
  entryId: string;
  kind: MediaKind;
  /** The real bytes. Blobs are stored in IndexedDB directly — never object URLs, which die. */
  blob: Blob;
  /**
   * The MIME type actually produced by this device. iOS Safari yields MP4/AAC where Android
   * yields OGG/WebM Opus, so the container is recorded rather than assumed
   * (ARCHITECTURE.md §5, "Do not assume one container").
   */
  mimeType: string;
  byteSize: number;
  /**
   * When the media was captured, ISO-8601. For photos this is the camera's own timestamp
   * (`File.lastModified`), read from the original file before any compression.
   */
  capturedAt: string;
  /** Audio only. */
  durationMs?: number;
  /** Photos only, after compression. */
  width?: number;
  height?: number;
  /** Photos only: the original byte size, kept as a record of what compression achieved. */
  originalByteSize?: number;
  /** Photos only: the original MIME type as the camera handed it over. */
  originalMimeType?: string;
  /** Where this individual file was taken; read before compression. */
  geo: GeoFix | null;
  uploadState: MediaUploadState;
  /** Set by B3 once the object store has the file. */
  storageKey: string | null;
  /**
   * SHA-256 of `blob`, 64 lowercase hex characters (B3, Dexie v4).
   *
   * The server requires it on every declared file and refuses a re-declaration whose checksum
   * changed, so it is computed **once, lazily, at the first upload attempt** and kept — never in
   * a Dexie upgrade hook, which would hash every blob on the phone before the first frame of the
   * app could paint (see `teren-db.ts` v4 for the full argument).
   *
   * `undefined` on rows written before v4 and on anything not yet uploaded: absence means "not
   * hashed yet", which is exactly what the lazy scheme needs it to mean.
   */
  sha256?: string;
  createdAt: string;
}

/**
 * What an outbox item is currently doing.
 *
 * `failed` and `blocked` are the two halves of the distinction B3 exists to make: `failed` is a
 * retryable setback with a `nextAttemptAt` on it, `blocked` is terminal and has none.
 */
export type OutboxState = 'queued' | 'in_flight' | 'failed' | 'blocked';

/**
 * One row per entry that has not yet been confirmed by the server: the unit of network work.
 * The outbox drives every network operation (ARCHITECTURE.md §11). B2 only ever creates rows in
 * `queued`; B3 adds the loop that moves them, using the attempt bookkeeping already carried here.
 */
export interface OutboxItem {
  /** Same id as the entry — one pending entry, one outbox row, no orphan pairs. */
  entryId: string;
  state: OutboxState;
  /**
   * Monotonic sequence number, assigned when the item is enqueued. The sync loop takes the
   * oldest item first; a plain timestamp would tie when two entries are queued in one second.
   */
  seq: number;
  attempts: number;
  lastAttemptAt: string | null;
  /** Earliest time the next attempt may run — exponential backoff with jitter lands here (B3). */
  nextAttemptAt: string | null;
  /** Diagnostic only; never shown raw to the user. */
  lastError: string | null;
  /**
   * The classified reason for the last failure (B3; `FailureKind` in `core/api/api-failure.ts`).
   *
   * This is what replaced the canned "connection dropped during upload" string the pending screen
   * used to show for every failure alike: the screen maps this value to a translation key, so what
   * the foreman reads is derived from what the server actually said. Null while an item has never
   * failed. Typed as `string` here so the local data model does not depend on the API layer.
   */
  failureKind: string | null;
  createdAt: string;
}

/** A construction site. Hardcoded demo data in B2; from `GET /api/projects` in B3. */
export interface Project {
  id: string;
  name: string;
  address: string;
}

/**
 * One slice of audio, written the moment `MediaRecorder` hands it over.
 *
 * This is what makes "the phone is the source of truth" true *during* a recording rather than
 * only after it. Chunks accumulating in a JavaScript array would all die together when the tab is
 * discarded or the battery gives out at minute three; on disk, every second that was captured
 * survives, and the start-up sweep assembles whatever is there into a draft.
 */
export interface AudioChunk {
  entryId: string;
  /** Order of arrival, 0-based. Part of the compound primary key, so a re-write is idempotent. */
  seq: number;
  blob: Blob;
  createdAt: string;
}

/**
 * A recording in progress.
 *
 * It carries everything needed to turn a set of orphaned chunks into a real entry without the
 * screen that started them: which site, when it started, what container the recorder chose, and
 * the position fix if one arrived. Deleted the moment its chunks become an entry.
 */
export interface CaptureSession {
  /** The entry id, minted with `crypto.randomUUID()` before the first byte is recorded. */
  entryId: string;
  projectId: string;
  projectName: string;
  /** When recording started, ISO-8601 — becomes the entry's `capturedAt`. */
  capturedAt: string;
  /** The MIME type the recorder is really producing on this device. */
  mimeType: string;
  geo: GeoFix | null;
  chunkCount: number;
  /** Arrival time of the last chunk — the honest end of a recording nobody stopped. */
  lastChunkAt: string | null;
  updatedAt: string;
}
