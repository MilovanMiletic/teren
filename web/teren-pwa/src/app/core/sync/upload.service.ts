import { DestroyRef, Injectable, effect, inject } from '@angular/core';
import {
  UploadFailure,
  classifyApiError,
  classifyStorageError,
  isTerminal,
} from '../api/api-failure';
import {
  CreateEntryRequest,
  DeclaredMedia,
  EntryResponse,
  MediaUploadTarget,
} from '../api/api-types';
import { TerenApiClient } from '../api/teren-api.client';
import { ConnectivityService } from '../connectivity.service';
import { EntryStore } from '../db/entry-store';
import { LocalEntry, LocalMedia, OutboxItem } from '../db/models';
import { SessionService } from '../session/session.service';
import { nextAttemptAt } from './backoff';
import { sha256Hex } from './sha256';

/**
 * The sync loop: the only thing in the app that talks to the network on the phone's behalf.
 *
 * Everything it does is driven from the outbox (ARCHITECTURE §11), never from a screen. A
 * component that started an upload would stop uploading the moment the foreman navigated away,
 * and the one guarantee this product sells is that evidence gets off the phone.
 *
 * ## One attempt
 *
 * Per ARCHITECTURE §8, in this order: **entry JSON → audio → photos, one at a time.** The report
 * is built from the recording, so the pipeline can start while photos are still climbing over a
 * bad connection.
 *
 * Every attempt starts from `POST /api/entries` rather than resuming from wherever the last one
 * stopped. That is not wasted work: the endpoint is idempotent on the client UUID (202 the first
 * time, 200 forever after) and it returns the entry's current server state, so one cheap call
 * both re-establishes the entry and tells us whether the server already holds it. Resuming from a
 * remembered step would mean trusting the phone's memory of a conversation the server is the
 * authority on.
 *
 * Files already verified in storage come back from `/media` with a null URL and are skipped, so a
 * fourteenth photo does not re-upload the first thirteen.
 *
 * ## What it refuses to do
 *
 * - It does not attempt when the OS reports no network, and — since F1 — it does not attempt when
 *   there is no usable credential either. The two are one condition as far as this loop is
 *   concerned: something outside the queue is missing, no entry is at fault, and nothing is
 *   written down about any of them.
 * - It does not retry a terminal failure. `blocked` items are invisible to the loop until a human
 *   presses "try again" — see `api-failure.ts` for why that distinction is the point of B3.
 * - It does not delete anything. A confirmed entry loses its outbox row (a work ticket, not
 *   evidence); its audio and photos stay on the phone for C1 to prune.
 * - It does not block the UI: nothing here is awaited by a component or by bootstrap.
 */
@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly api = inject(TerenApiClient);
  private readonly store = inject(EntryStore);
  private readonly connectivity = inject(ConnectivityService);
  private readonly session = inject(SessionService);

  /** Serialises passes: one attempt at a time, in outbox order, exactly as §11 prescribes. */
  private running: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  /**
   * Wire the triggers ARCHITECTURE §11 names — app open, connectivity regained, and a timer —
   * plus one more the web platform makes necessary: coming back to the front, because a
   * backgrounded tab's timers are throttled or stopped outright and iOS has no Background Sync at
   * all.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // Connectivity is a signal, so this covers both the `online` event and the initial state.
    effect(() => {
      if (this.connectivity.online()) {
        this.wake();
      }
    });

    // A credential change is the second thing that can make a stuck queue movable, and — unlike a
    // network that comes back — nothing else in the app notices it.
    //
    // A phone whose device was revoked accumulates rows failing with `unauthenticated`; a phone
    // that was never activated may carry rows an older build wrote to `blocked`. Both are fixed by
    // the same event: the foreman types a code. When that happens the auth-blocked rows are
    // released and a pass runs, so a morning's entries start moving with **no per-entry tap** —
    // which is the whole difference between a queue that heals and a chore.
    //
    // `seen` is captured before the effect so start-up does not count as a change. That guard is
    // not cosmetic: the loop is documented never to pick a `blocked` item up on its own, and an
    // effect that fired on the first read would quietly break exactly that promise.
    let seen = this.session.token();
    effect(() => {
      const token = this.session.token();
      if (token === seen) {
        return;
      }
      seen = token;
      // Losing a credential releases nothing. Revocation is not an invitation to retry.
      if (!token) {
        return;
      }
      this.running = this.running
        .then(() => this.store.releaseBlockedByAuth())
        .then(() => this.pass())
        .catch(() => undefined);
    });

    // A new entry reaching the queue should go out now, not at the next tick. The subscription
    // fires on our own writes too; the `running` chain and the due-time filter make that a no-op
    // rather than a spin.
    const subscription = this.store
      .watchOutboxBacklog()
      .subscribe({ next: () => this.wake(), error: () => undefined });

    if (typeof document !== 'undefined') {
      const onVisible = () => {
        if (document.visibilityState === 'visible') {
          this.wake();
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      inject(DestroyRef).onDestroy(() => {
        document.removeEventListener('visibilitychange', onVisible);
      });
    }

    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.clearTimer();
    });

    // Before anything else this process does: pick up after the process that came before it.
    //
    // An `in_flight` row on disk describes an attempt that was running in a page which no longer
    // exists — the phone went in a pocket, iOS discarded the tab, the battery died. Nothing else
    // will ever look at it: it is not due, not backlog, not stuck, and has no retry button, while
    // the pending screen keeps saying "Slanje na server". ARCHITECTURE §11 names this exact case
    // and promises resumption on next open; this line is that promise.
    //
    // Chained onto `running` ahead of the first `wake()`, so the release is complete before the
    // first pass reads the due list and the released rows are picked up in the same pass.
    this.running = this.running.then(() => this.store.releaseInFlight()).then(() => undefined);
    this.wake();
  }

  /** Ask for a pass. Cheap and idempotent — call it from anywhere something might have changed. */
  wake(): void {
    this.running = this.running.then(() => this.pass()).catch(() => undefined);
  }

  /** Runs a pass and resolves when it is finished. For the specs and for `start()`. */
  async flush(): Promise<void> {
    this.wake();
    await this.running;
  }

  /**
   * One pass over everything that is due.
   *
   * The due list is snapshotted at the start, so an item that fails and re-arms cannot be picked
   * up again inside the same pass — that is the difference between a retry loop and a spin.
   */
  private async pass(): Promise<void> {
    this.clearTimer();

    if (!this.connectivity.online()) {
      return;
    }

    // No credential: make no attempt, change no state, record no failure.
    //
    // **The most important line in F1.** It makes "this phone has no usable token" structurally
    // identical to "this phone has no signal" — the condition the entire app is built to survive.
    // Without it the pass runs, `send()` throws `not_configured`, that kind is terminal, and a
    // device that loses its session mid-queue blocks the morning by a second route, having blamed
    // the entries for a problem that is not theirs.
    //
    // Returning without scheduling a wake is the same shape as the offline branch above, and safe
    // for the same reason: the credential-change effect in `start()` wakes the loop the moment a
    // token arrives, exactly as the connectivity effect does when the network comes back.
    if (!this.session.usable()) {
      return;
    }

    const due = await this.store.dueOutboxItems();
    for (const item of due) {
      if (!this.connectivity.online()) {
        break;
      }
      await this.attempt(item);
    }

    await this.scheduleNextWake();
  }

  /** Sleep exactly until the earliest backing-off item is due, rather than polling. */
  private async scheduleNextWake(): Promise<void> {
    const next = await this.store.earliestNextAttempt();
    if (!next || typeof setTimeout === 'undefined') {
      return;
    }
    const delay = Math.max(1_000, Date.parse(next) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---- One entry -----------------------------------------------------------------------------

  private async attempt(item: OutboxItem): Promise<void> {
    const entry = await this.store.getEntry(item.entryId);
    if (!entry) {
      // A ticket for work that no longer exists. Not evidence, and nothing can ever send it.
      await this.store.discardOrphanOutboxItem(item.entryId);
      return;
    }

    await this.store.setOutboxState(item.entryId, 'in_flight');

    try {
      await this.send(entry);
    } catch (error) {
      await this.recordFailure(item.entryId, error);
    } finally {
      await this.releaseIfStillInFlight(item.entryId);
    }
  }

  /**
   * Never let an attempt end with the row still marked in flight.
   *
   * `releaseInFlight()` at start-up covers the process that dies mid-upload; this covers the same
   * strand happening *inside* a live process, which it can: if the Dexie write in
   * `recordFailure` throws — an exhausted quota, a store that closed under us — the failure is
   * swallowed by `wake()`'s catch and the row keeps a state whose owner has already gone away.
   * The entry would then sit there claiming to be uploading until the next launch.
   *
   * A successful attempt has already deleted the row, so the common path does nothing here.
   */
  private async releaseIfStillInFlight(entryId: string): Promise<void> {
    try {
      const item = await this.store.getOutboxItem(entryId);
      if (item?.state !== 'in_flight') {
        return;
      }
      await this.store.setOutboxState(entryId, 'failed', {
        failureKind: 'unknown',
        lastError: 'the attempt ended without recording an outcome',
        nextAttemptAt: nextAttemptAt(item.attempts),
      });
    } catch {
      // The store itself is refusing writes. Start-up will release the row on the next launch,
      // and throwing from here would only take the rest of the pass down with it.
    }
  }

  /** The upload conversation for one entry. Throws {@link UploadFailure} on any setback. */
  private async send(entry: LocalEntry): Promise<void> {
    // Unreachable since F1 — `pass()` returns before it gets here when the session is unusable —
    // and kept as a backstop rather than deleted, because `not_configured` still has to *mean*
    // something precise elsewhere: three branches (`archive/entry-detail.ts`, twice, and
    // `confirm/confirm-page.ts`) read it as "this phone was never activated, so nothing it holds
    // was ever sent". Producing it on the entry path would make that sentence false about sealed
    // entries; leaving the guard in place costs one comparison and keeps the meaning intact.
    if (!this.api.configured) {
      throw new UploadFailure(
        'not_configured',
        'this build has no device token; nothing can be uploaded',
      );
    }

    // 1. Entry JSON. Idempotent, and the answer tells us where we stand.
    let server: EntryResponse;
    try {
      server = await this.api.createEntry(toCreateRequest(entry));
    } catch (error) {
      throw await this.classify(entry.id, error);
    }

    if (server.received_at) {
      // The server already holds the complete entry — a previous attempt got further than this
      // phone knew. Nothing left to send.
      await this.confirm(entry.id, server);
      return;
    }

    await this.store.setServerStatus(entry.id, server.status);

    // 2 & 3. Media: declare everything, then upload audio first and photos one at a time.
    const media = await this.store.listMediaForUpload(entry.id);
    if (media.length > 0) {
      const targets = await this.declare(entry.id, media);
      for (const file of media) {
        await this.uploadOne(file, targets.get(file.id));
      }
    }

    // 4. Tell the server we are done, and let it verify.
    let completion;
    try {
      completion = await this.api.completeEntry(entry.id);
    } catch (error) {
      throw await this.classify(entry.id, error);
    }

    if (completion.ready) {
      await this.confirm(entry.id, completion.entry);
      return;
    }

    // `/complete` looked and did not find everything it was promised. `pending` means an object
    // is not in storage yet, `failed` means it is there at the wrong size — both mean the bytes
    // have to go up again, so the local rows are put back to `pending` and the next attempt
    // re-declares them (which re-signs a fresh URL) and re-PUTs.
    const outstanding = [...completion.pending_media, ...completion.failed_media];
    for (const mediaId of outstanding) {
      await this.store.setMediaUploadState(mediaId, 'pending');
    }

    throw new UploadFailure(
      'incomplete',
      completion.reason ?? `${outstanding.length} file(s) did not reach storage`,
    );
  }

  private async declare(
    entryId: string,
    media: readonly LocalMedia[],
  ): Promise<Map<string, MediaUploadTarget>> {
    const files: DeclaredMedia[] = [];
    for (const file of media) {
      files.push({
        id: file.id,
        kind: file.kind,
        content_type: file.mimeType,
        byte_size: file.byteSize,
        sha256: await this.checksum(file),
        captured_at: file.capturedAt,
      });
    }

    try {
      const response = await this.api.declareMedia(entryId, { files });
      return new Map(response.uploads.map((target) => [target.media_id, target]));
    } catch (error) {
      throw await this.classify(entryId, error);
    }
  }

  /**
   * The file's checksum, computed once and kept (Dexie v4).
   *
   * Re-hashing on every attempt would read the whole blob again for nothing — and worse, the
   * server refuses a re-declaration whose checksum changed, so a hash that is stable across
   * attempts is a correctness requirement, not an optimisation.
   */
  private async checksum(file: LocalMedia): Promise<string> {
    if (file.sha256) {
      return file.sha256;
    }
    // Throws `insecure_context` when `crypto.subtle` is missing — terminal, and told apart from
    // every other failure because "your evidence needs an https address" is advice a foreman
    // (or the founder testing over a tunnel) can act on, and a retry is not.
    const digest = await sha256Hex(file.blob);
    await this.store.setMediaSha256(file.id, digest);
    return digest;
  }

  private async uploadOne(file: LocalMedia, target: MediaUploadTarget | undefined): Promise<void> {
    if (!target) {
      throw new UploadFailure('unknown', `the server issued no target for media ${file.id}`);
    }

    if (target.url === null) {
      // Already verified in storage: the server does not hand out a second write permission for
      // evidence it has vouched for. Bring the local row into line and move on.
      await this.store.markMediaUploaded(file.id, target.object_key);
      return;
    }

    try {
      await this.api.putObject(target, file.blob);
    } catch (error) {
      throw classifyStorageError(error);
    }
    await this.store.markMediaUploaded(file.id, target.object_key);
  }

  private async confirm(entryId: string, server: EntryResponse): Promise<void> {
    await this.store.markConfirmedByServer(entryId, {
      serverStatus: server.status,
      confirmedAt: server.received_at ?? new Date().toISOString(),
    });
  }

  // ---- Failure ------------------------------------------------------------------------------

  /**
   * Turn an error from an `/api` call into a verdict, resolving the one status that cannot be
   * judged from the response alone.
   *
   * **A `409` is ambiguous and must never be guessed at.** The server answers `409` to a media
   * declaration on an entry it has already sealed — which means it *has* the evidence and the
   * phone is merely late finding out — and it answers `409` to a declaration it genuinely
   * refuses: a changed checksum, a twenty-first photo, a media id belonging to another entry.
   * Treating the first as a failure would leave a delivered entry stuck on the phone for ever;
   * treating the second as success would lose one.
   *
   * The tie-break is data, not prose: re-read the entry and look at `received_at`. Parsing the
   * English `detail` string would make the client's correctness depend on the server's wording.
   */
  private async classify(entryId: string, error: unknown): Promise<Error> {
    const failure = classifyApiError(error);
    if (failure.status !== 409) {
      return failure;
    }

    let server: EntryResponse;
    try {
      server = await this.api.getEntry(entryId);
    } catch (lookupError) {
      // We could not find out which kind of 409 this was. Retry rather than block: an unresolved
      // ambiguity must not be resolved against the evidence.
      const lookup = classifyApiError(lookupError);
      return new UploadFailure(
        lookup.kind === 'offline' || lookup.kind === 'server' ? lookup.kind : 'unknown',
        `conflict could not be resolved: ${lookup.message}`,
      );
    }

    if (server.received_at) {
      return new AlreadyReceived(server);
    }
    return failure;
  }

  private async recordFailure(entryId: string, error: unknown): Promise<void> {
    // The success that arrives dressed as an error: a 409 the lookup proved was a sealed entry.
    if (error instanceof AlreadyReceived) {
      await this.confirm(entryId, error.entry);
      return;
    }

    const failure = error instanceof UploadFailure ? error : classifyApiError(error);

    // Terminal on its first appearance or not at all. There is deliberately no "it has failed
    // often enough, give up" rule: an unreachable server and an object that has not landed yet
    // are both conditions the far end fixes, and abandoning an entry over them would break
    // PROJECT.md principle 3. Repetition changes what the *screen* says (see
    // `STALLED_AFTER_ATTEMPTS`), never whether the queue keeps trying.
    if (isTerminal(failure.kind)) {
      await this.store.setOutboxState(entryId, 'blocked', {
        failureKind: failure.kind,
        lastError: failure.message,
      });
      return;
    }

    const item = await this.store.getOutboxItem(entryId);
    await this.store.setOutboxState(entryId, 'failed', {
      failureKind: failure.kind,
      lastError: failure.message,
      // Capped exponential backoff with jitter: a recovered network is picked up within ten
      // minutes however long the outage was, rather than at the end of a doubling that ran away.
      nextAttemptAt: nextAttemptAt(item?.attempts ?? 1),
    });
  }
}

/**
 * Not an error: the entry is already on the server, complete and sealed.
 *
 * Thrown so the `409` case can unwind the attempt from wherever it happened without every call
 * site growing a "or maybe we are done" branch, and caught at the one place that decides what an
 * attempt's outcome was.
 */
class AlreadyReceived extends Error {
  constructor(readonly entry: EntryResponse) {
    super('the server has already received this entry');
    this.name = 'AlreadyReceived';
  }
}

function toCreateRequest(entry: LocalEntry): CreateEntryRequest {
  const request: CreateEntryRequest = {
    id: entry.id,
    project_id: entry.projectId,
    // The site day, taken from the phone's local calendar — not the upload day, and not UTC.
    entry_date: entry.localDay,
    created_at: entry.capturedAt,
  };

  if (entry.geo) {
    request.latitude = entry.geo.latitude;
    request.longitude = entry.geo.longitude;
    if (entry.geo.accuracyM !== null) {
      request.gps_accuracy_m = entry.geo.accuracyM;
    }
  }

  return request;
}
