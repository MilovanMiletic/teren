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
 * Every outbox state, enumerable at runtime and kept complete by the compiler.
 *
 * `Record<OutboxState, true>` is the one construct TypeScript checks for *completeness*: adding a
 * member to the union above and forgetting it here is a compile error, where a hand-written array
 * of literals would happily be missing one and every spec that walked it would keep passing while
 * checking less than it claimed. Same pattern as `CONFIRM_FAILURES` and `REPORT_FAILURES`.
 *
 * The `true` values carry no meaning — the keys are the point.
 */
const ALL_OUTBOX_STATES: Record<OutboxState, true> = {
  queued: true,
  in_flight: true,
  failed: true,
  blocked: true,
};

/** Every state a row can be in, for the specs that must walk all of them. */
export const OUTBOX_STATES = Object.keys(ALL_OUTBOX_STATES) as readonly OutboxState[];

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

/**
 * What a person has typed on the confirmation screen and not yet sent.
 *
 * The confirmation screen is a *typing* screen — often the only place a record's content is
 * produced at all, because an entry whose extraction failed arrives with nothing but a
 * transcript. Holding that typing in a component's memory would mean a locked phone, a tab the
 * OS discarded, or a tap on "back" silently destroying it, which is principle 3 broken on the one
 * screen where the human, not the recorder, is the source.
 *
 * So it is written here on every change and removed only once the server has answered. The stored
 * value is the *editing* shape (`EntryDraft` in `core/confirm/entry-draft.ts`), not the wire
 * shape: a half-typed quantity and an empty row the foreman is about to fill in are exactly what
 * must survive, and both are gone by the time a payload is built. Typed as `unknown` so the local
 * store stays free of the confirmation layer's model, and narrowed by `readStoredDraft` on the
 * way out — a draft written by an older build must never be able to throw on restore.
 */
export interface ConfirmDraft {
  /** Same id as the entry: one entry, one draft. */
  entryId: string;
  draft: unknown;
  updatedAt: string;
}

/**
 * Whether the server is waiting for a *person*, not for the machine.
 *
 * Two statuses, and they are the same news to the foreman even though they are opposite news to
 * the pipeline: `awaiting_confirmation` means extraction succeeded and its answer needs checking,
 * `needs_review` means it failed and the day has to be typed from the transcript. Either way the
 * entry stops moving until he opens it, and nothing downstream — no report, no email — happens
 * without him.
 *
 * Written once, here, because every screen that has to say "this needs you" asks the same
 * question, and a screen that answered it differently would send him to a gate that is not there.
 */
export function needsConfirmation(serverStatus: string | null | undefined): boolean {
  return serverStatus === 'awaiting_confirmation' || serverStatus === 'needs_review';
}

/**
 * Whether a confirmed entry can still be corrected — the last cheap chance to fix a mistake.
 *
 * `POST /api/entries/{id}/confirm` accepts a second call: confirming is not a one-way door until
 * the report goes out. The moment it does, `reported_at` fires the trigger that makes the row
 * immutable and undeletable for ever (B6), and the only remedy left is a correction entry
 * referring back to this one (C4, not built). So the window between `confirmed` and `reported` is
 * narrow, it closes on its own, and a foreman who spots a typo after walking away must be able to
 * find his way back into the gate — which is what this predicate exists to answer.
 *
 * **Both halves are load-bearing.** `confirmed` alone is not enough: a row whose status this
 * device last heard about hours ago may since have been reported, and `reported_at` is the field
 * that says so — the same field `ConfirmService` re-reads to decide what a `409` meant, never the
 * server's English prose. When it is unknown (the server could not be asked) the gate itself is
 * the backstop: `ConfirmPage` re-reads the entry and refuses to render a form over a reported one.
 *
 * This is deliberately **not** {@link needsConfirmation}. That question is "does this entry need a
 * person?", and Home's attention row is built on it — a confirmed entry needs nobody, and nagging
 * a foreman about work he has already done is noise. This one is "may he change his mind?", which
 * only the archive asks, because the archive is where a person goes *looking* for a past entry.
 */
export function canRevise(
  serverStatus: string | null | undefined,
  reportedAt: string | null | undefined,
): boolean {
  return serverStatus === 'confirmed' && !reportedAt;
}

/**
 * One recorded action, waiting for a network (D5, `core/telemetry/action-log.service.ts`).
 *
 * ## Why it is on disk at all
 *
 * The same reason everything else on this device is: a screen that was closed, a tab the phone
 * killed, a reload in the middle of a batch. An in-memory array would lose exactly the actions
 * around a crash, which are the actions a log exists to explain.
 *
 * ## Why it is the one table that may be thrown away
 *
 * Every other row in this store is evidence and nothing deletes it before the server confirms it
 * (PROJECT.md principle 3). These are not evidence. The buffer is **bounded** and drops its oldest
 * rows on overflow, because a log that could grow without limit would eventually take the storage
 * quota that a day's photographs need — the one way telemetry could cost a foreman his work.
 *
 * `seq` is an auto-incrementing primary key, so key order is arrival order: the flush takes the
 * head, the trim takes the head, and no secondary index is needed for either.
 */
export interface BufferedEvent {
  /** Auto-incremented by Dexie. Never set by hand. */
  seq?: number;
  /**
   * Which credential this action was performed under — see `core/telemetry/log-surface.ts`.
   *
   * Stored on the row rather than resolved at flush time, because a batch written while a foreman
   * was recording must not be sent under an admin session that was opened ten minutes later.
   */
  surface: 'device' | 'admin';
  /** The event, exactly as it will go on the wire. Composed and scrubbed before it got here. */
  event: unknown;
}
