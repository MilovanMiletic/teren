import { HttpErrorResponse } from '@angular/common/http';
import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { TEST_PROJECT, captureEntry } from '../../testing/capture-fixture';
import {
  CompleteEntryResponse,
  CreateEntryRequest,
  DeclareMediaRequest,
  DeclareMediaResponse,
  EntryResponse,
  MediaUploadTarget,
} from '../api/api-types';
import { TerenApiClient } from '../api/teren-api.client';
import { ConnectivityService } from '../connectivity.service';
import { EntryStore } from '../db/entry-store';
import { TEREN_DB, TerenDb } from '../db/teren-db';
import { UploadService } from './upload.service';

/**
 * A stand-in for the server that behaves the way `Teren.Api` behaves, not the way the client
 * hopes it does: `POST /entries` is idempotent and reports `received_at`, `/media` hands back a
 * null URL for anything already verified, and `/complete` distinguishes ready from pending.
 *
 * Written by hand rather than as a pile of mock functions so the interesting cases — a sealed
 * entry answering 409, a completion that is not ready — can be set up in one line each and read
 * as what they are.
 */
class FakeApi {
  configured = true;

  /** What the server currently believes about the entry. */
  status = 'received';
  receivedAt: string | null = null;

  /** Media ids the store has vouched for; these come back with a null URL. */
  readonly verified = new Set<string>();

  // Programmable failures. Each is thrown once unless `sticky` is set.
  failCreate: unknown = null;
  failDeclare: unknown = null;
  failPut: unknown = null;
  failGet: unknown = null;
  sticky = false;

  /** When false, `/complete` reports everything not yet PUT as pending, exactly as the API does. */
  completeReady = true;

  /**
   * Seal the entry *after* answering `POST /entries` — the race the sealed-entry 409 comes from.
   *
   * A previous attempt's `/complete` landed while this attempt was already in the middle of its
   * conversation, so `POST /entries` still reported `received_at: null` and the following
   * `/media` is refused by an entry that is now closed.
   */
  sealAfterCreate: string | null = null;

  readonly created: CreateEntryRequest[] = [];
  readonly declared: DeclareMediaRequest[] = [];
  readonly put: { mediaId: string; size: number; contentType: string | undefined }[] = [];
  completeCalls = 0;
  getCalls = 0;

  async listProjects() {
    return [];
  }

  async createEntry(request: CreateEntryRequest): Promise<EntryResponse> {
    this.created.push(request);
    this.take('failCreate');
    const response = this.entry(request.id);
    if (this.sealAfterCreate) {
      this.receivedAt = this.sealAfterCreate;
      this.sealAfterCreate = null;
    }
    return response;
  }

  async declareMedia(entryId: string, request: DeclareMediaRequest): Promise<DeclareMediaResponse> {
    this.declared.push(request);
    this.take('failDeclare');
    const uploads: MediaUploadTarget[] = request.files.map((file) => {
      const objectKey = `company/c/project/p/entry/${entryId}/${file.id}`;
      const isVerified = this.verified.has(file.id);
      return {
        media_id: file.id,
        kind: file.kind,
        object_key: objectKey,
        upload_status: isVerified ? 'verified' : 'pending',
        url: isVerified ? null : `http://storage.test/${objectKey}?X-Amz-Signature=abc`,
        method: isVerified ? null : 'PUT',
        // The server signs its *normalised* content type, so this is what the PUT must echo.
        required_headers: isVerified ? null : { 'Content-Type': file.content_type.split(';')[0] },
        expires_at: isVerified ? null : '2026-08-29T10:15:00.000Z',
      };
    });
    return { entry_id: entryId, uploads };
  }

  async putObject(target: MediaUploadTarget, blob: Blob): Promise<void> {
    this.take('failPut');
    this.put.push({
      mediaId: target.media_id,
      size: blob.size,
      contentType: target.required_headers?.['Content-Type'],
    });
    this.verified.add(target.media_id);
  }

  async completeEntry(entryId: string): Promise<CompleteEntryResponse> {
    this.completeCalls += 1;
    const declaredIds = this.declared.flatMap((request) => request.files.map((file) => file.id));
    const pending = this.completeReady
      ? []
      : declaredIds.filter((id) => !this.verified.has(id)).length > 0
        ? declaredIds.filter((id) => !this.verified.has(id))
        : declaredIds.slice(0, 1);

    const ready = this.completeReady && pending.length === 0;
    if (ready) {
      this.receivedAt = '2026-08-29T10:05:00.000Z';
    }
    return {
      ready,
      reason: ready ? null : '1 file(s) have not arrived in storage.',
      pending_media: pending,
      failed_media: [],
      entry: this.entry(entryId),
    };
  }

  async getEntry(entryId: string): Promise<EntryResponse> {
    this.getCalls += 1;
    this.take('failGet');
    return this.entry(entryId);
  }

  private entry(id: string): EntryResponse {
    return {
      id,
      project_id: TEST_PROJECT.id,
      entry_date: '2026-08-29',
      status: this.status,
      created_at: '2026-08-29T10:00:00.000Z',
      received_at: this.receivedAt,
      confirmed_at: null,
      reported_at: null,
      failure_reason: null,
      media: [],
    };
  }

  private take(slot: 'failCreate' | 'failDeclare' | 'failPut' | 'failGet'): void {
    const error = this[slot];
    if (!error) {
      return;
    }
    if (!this.sticky) {
      this[slot] = null;
    }
    throw error;
  }
}

function httpError(status: number, detail?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    statusText: 'error',
    url: 'http://localhost:5080/api/entries',
    error: detail ? { title: 'Problem', detail } : null,
  });
}

describe('UploadService', () => {
  let db: TerenDb;
  let store: EntryStore;
  let api: FakeApi;
  let online: WritableSignal<boolean>;
  let uploads: UploadService;

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    api = new FakeApi();
    online = signal(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: TEREN_DB, useValue: db },
        { provide: TerenApiClient, useValue: api as unknown as TerenApiClient },
        { provide: ConnectivityService, useValue: { online: online.asReadonly() } },
      ],
    });

    store = TestBed.inject(EntryStore);
    uploads = TestBed.inject(UploadService);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  /** An entry captured and handed to the outbox, exactly as pressing "Gotovo" leaves it. */
  async function queued(options: { photoCount?: number } = {}) {
    const entry = await captureEntry(store, { photoCount: options.photoCount ?? 0 });
    await store.queue(entry.id);
    return entry.id;
  }

  // ---- The money path -------------------------------------------------------------------------

  describe('a successful upload', () => {
    it('sends entry JSON, then the audio, then photos one at a time', async () => {
      const entryId = await queued({ photoCount: 2 });

      await uploads.flush();

      // ARCHITECTURE §8: the report is built from the recording, so the audio goes first and
      // the pipeline can start while photos are still climbing over a bad connection.
      const media = await store.listMediaForUpload(entryId);
      expect(media.map((file) => file.kind)).toEqual(['audio', 'photo', 'photo']);
      expect(api.put.map((call) => call.mediaId)).toEqual(media.map((file) => file.id));
      expect(api.created).toHaveLength(1);
      expect(api.completeCalls).toBe(1);
    });

    it('declares the entry with the site day and the position fix, not the upload day', async () => {
      const entryId = await queued();

      await uploads.flush();

      const entry = await store.getEntry(entryId);
      expect(api.created[0]).toMatchObject({
        id: entryId,
        project_id: TEST_PROJECT.id,
        entry_date: entry!.localDay,
        created_at: entry!.capturedAt,
      });
    });

    it('declares a 64-hex checksum per file and echoes the signed content type on the PUT', async () => {
      await queued({ photoCount: 1 });

      await uploads.flush();

      for (const file of api.declared[0].files) {
        expect(file.sha256).toMatchObject(expect.any(String));
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // The blob's own type is `audio/ogg;codecs=opus`; the server signs `audio/ogg`. Sending
      // the blob's type would produce a signature mismatch nothing in the error would explain.
      expect(api.put[0].contentType).toBe('audio/ogg');
    });

    it('marks the entry confirmed by the server and takes it off the pending screen', async () => {
      const entryId = await queued();

      await uploads.flush();

      const entry = await store.getEntry(entryId);
      expect(entry?.status).toBe('confirmed_by_server');
      expect(entry?.confirmedByServerAt).toBe('2026-08-29T10:05:00.000Z');
      expect(entry?.serverStatus).toBe('received');
      expect(await store.getOutboxItem(entryId)).toBeUndefined();
    });

    it('deletes no evidence — pruning local media is C1, not B3', async () => {
      const entryId = await queued({ photoCount: 2 });

      await uploads.flush();

      const media = await store.listMediaForUpload(entryId);
      expect(media).toHaveLength(3);
      for (const file of media) {
        expect(file.blob.size).toBeGreaterThan(0);
        expect(file.uploadState).toBe('uploaded');
        expect(file.storageKey).toContain(entryId);
      }
    });

    it('persists each checksum so a second attempt neither re-hashes nor re-declares a new one', async () => {
      const entryId = await queued();
      await uploads.flush();

      const first = (await store.listMediaForUpload(entryId))[0];
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

      // A hash recomputed per attempt would be wasted work at best; at worst a declaration whose
      // checksum changed, which the server refuses with a 409 it will never stop refusing.
      const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest');
      const entry2 = await captureEntry(store);
      await store.setMediaSha256((await store.listMediaForUpload(entry2.id))[0].id, 'a'.repeat(64));
      await store.queue(entry2.id);
      api.receivedAt = null;
      api.verified.clear();
      await uploads.flush();

      expect(digestSpy).not.toHaveBeenCalled();
      expect(api.declared.at(-1)!.files[0].sha256).toBe('a'.repeat(64));
      digestSpy.mockRestore();
    });

    it('skips a file the server has already verified instead of uploading it twice', async () => {
      const entryId = await queued({ photoCount: 1 });
      const media = await store.listMediaForUpload(entryId);
      // The audio got through on a previous attempt; only the photo is still outstanding.
      api.verified.add(media[0].id);

      await uploads.flush();

      expect(api.put.map((call) => call.mediaId)).toEqual([media[1].id]);
      // The local row is still brought into line — a null URL means "already yours", not "skip".
      expect((await store.listMediaForUpload(entryId))[0].uploadState).toBe('uploaded');
    });
  });

  // ---- Retryable ------------------------------------------------------------------------------

  describe('a retryable failure', () => {
    it('backs off and keeps the entry queued when the network drops', async () => {
      const entryId = await queued();
      api.failCreate = httpError(0);

      await uploads.flush();

      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('failed');
      expect(item?.failureKind).toBe('offline');
      expect(item?.attempts).toBe(1);
      expect(Date.parse(item!.nextAttemptAt!)).toBeGreaterThan(Date.now());
      expect((await store.getEntry(entryId))?.status).toBe('failed');
    });

    it('sends the entry on a later pass once the failure clears', async () => {
      const entryId = await queued();
      api.failCreate = httpError(503);

      await uploads.flush();
      expect((await store.getOutboxItem(entryId))?.state).toBe('failed');

      // Fast-forward the backoff rather than waiting it out; the loop's due-time filter is what
      // is under test elsewhere.
      await store.setOutboxState(entryId, 'queued');
      await uploads.flush();

      expect((await store.getEntry(entryId))?.status).toBe('confirmed_by_server');
    });

    it('treats `/complete` answering pending as retryable and re-arms the outstanding files', async () => {
      // The server looked in storage and did not find everything it was promised. The bytes have
      // to go up again — a fresh declare re-signs the URL — so this is a setback, not a verdict.
      const entryId = await queued({ photoCount: 1 });
      api.completeReady = false;

      await uploads.flush();

      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('failed');
      expect(item?.failureKind).toBe('incomplete');
      expect(item?.nextAttemptAt).not.toBeNull();
      // The entry is still on the pending screen, which is the truth: the server has not got it.
      expect((await store.getEntry(entryId))?.status).toBe('failed');

      const media = await store.listMediaForUpload(entryId);
      expect(media.some((file) => file.uploadState === 'pending')).toBe(true);
    });

    it('keeps a failure that repeats in the queue, counting the attempts rather than giving up', async () => {
      const entryId = await queued();
      api.completeReady = false;

      for (let pass = 0; pass < 10; pass += 1) {
        await store.setOutboxState(entryId, 'queued');
        await uploads.flush();
      }

      // Ten failed attempts and the entry is still queued for an eleventh. Abandoning it would
      // break principle 3 for a condition the far end fixes; what changes instead is what the
      // pending screen calls it, once `attempts` passes `STALLED_AFTER_ATTEMPTS`.
      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('failed');
      expect(item?.failureKind).toBe('incomplete');
      expect(item?.attempts).toBe(10);
      expect(item?.nextAttemptAt).not.toBeNull();
    });

    it.each([500, 502, 503])(
      'keeps retrying a %d rather than abandoning the entry',
      async (status) => {
        // `/complete` answers 500 for one malformed server state. The server already holds the
        // entry's JSON; the row is repaired server-side and the next attempt goes through.
        const entryId = await queued();
        api.failCreate = httpError(status);

        await uploads.flush();

        expect(await store.getOutboxItem(entryId)).toMatchObject({
          state: 'failed',
          failureKind: 'server',
        });

        await store.setOutboxState(entryId, 'queued');
        await uploads.flush();
        expect((await store.getEntry(entryId))?.status).toBe('confirmed_by_server');
      },
    );

    it('does not attempt anything while the OS reports no network', async () => {
      const entryId = await queued();
      online.set(false);

      await uploads.flush();

      expect(api.created).toHaveLength(0);
      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('queued');
      expect(item?.attempts).toBe(0);
    });
  });

  // ---- Terminal -------------------------------------------------------------------------------

  describe('a terminal failure', () => {
    it('blocks the entry on a 404 instead of retrying a project that does not exist', async () => {
      // The failure this distinction exists for. Retried for ever, it would show "waiting to
      // upload" over an entry that can never leave the phone.
      const entryId = await queued();
      api.failCreate = httpError(404, 'Project … was not found.');
      api.sticky = true;

      await uploads.flush();

      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('blocked');
      expect(item?.failureKind).toBe('rejected');
      // No next attempt: that is what makes it terminal rather than merely slow.
      expect(item?.nextAttemptAt).toBeNull();
      expect((await store.getEntry(entryId))?.status).toBe('blocked');
    });

    it('leaves every byte of the evidence on the phone when it blocks', async () => {
      const entryId = await queued({ photoCount: 2 });
      api.failCreate = httpError(404);
      api.sticky = true;

      await uploads.flush();

      const media = await store.listMediaForUpload(entryId);
      expect(media).toHaveLength(3);
      expect(media.every((file) => file.blob.size > 0)).toBe(true);
      expect(await store.getEntry(entryId)).toBeDefined();
    });

    it('never picks a blocked item up again on its own', async () => {
      const entryId = await queued();
      api.failCreate = httpError(400);
      api.sticky = true;

      await uploads.flush();
      const attemptsAfterBlock = (await store.getOutboxItem(entryId))!.attempts;

      await uploads.flush();
      await uploads.flush();

      // Battery, not pedantry: an item the server will refuse identically for ever must stop
      // being asked.
      expect((await store.getOutboxItem(entryId))?.attempts).toBe(attemptsAfterBlock);
      expect(api.created).toHaveLength(1);
    });

    it('takes a blocked item back when the foreman asks, and resets its attempt count', async () => {
      const entryId = await queued();
      api.failCreate = httpError(400);
      await uploads.flush();
      expect((await store.getOutboxItem(entryId))?.state).toBe('blocked');

      await store.retryNow(entryId);
      expect(await store.getOutboxItem(entryId)).toMatchObject({
        state: 'queued',
        attempts: 0,
        failureKind: null,
      });

      await uploads.flush();
      expect((await store.getEntry(entryId))?.status).toBe('confirmed_by_server');
    });

    it('blocks with `insecure_context` when the origin cannot hash, rather than retrying', async () => {
      // `crypto.subtle` is absent on a plain-http tunnel. Nothing can be declared without a
      // checksum, and no retry turns http:// into https:// — so the screen has to say so.
      const entryId = await queued();
      const subtle = globalThis.crypto.subtle;
      Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });

      try {
        await uploads.flush();
      } finally {
        Object.defineProperty(globalThis.crypto, 'subtle', { value: subtle, configurable: true });
      }

      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('blocked');
      expect(item?.failureKind).toBe('insecure_context');
      // It got as far as creating the entry; only the media declaration was impossible.
      expect(api.declared).toHaveLength(0);
    });

    it('blocks when the build carries no device token', async () => {
      const entryId = await queued();
      api.configured = false;

      await uploads.flush();

      expect(await store.getOutboxItem(entryId)).toMatchObject({
        state: 'blocked',
        failureKind: 'not_configured',
      });
      expect(api.created).toHaveLength(0);
    });
  });

  // ---- The ambiguous 409 ----------------------------------------------------------------------

  describe('a 409 from the server', () => {
    it('counts a sealed entry as success — the server already has the evidence', async () => {
      // `/media` answers 409 once `/complete` has sealed the entry. The realistic way to get
      // here is the outbox replaying a declare the server already acted on. Recording that as a
      // failure would strand a delivered entry on the phone for ever.
      const entryId = await queued();
      api.failDeclare = httpError(409, 'its evidence set is sealed and no further media …');
      // `POST /entries` still answered `received_at: null`; the entry was sealed a moment later.
      api.sealAfterCreate = '2026-08-29T10:05:00.000Z';
      api.status = 'processing';

      await uploads.flush();

      const entry = await store.getEntry(entryId);
      expect(entry?.status).toBe('confirmed_by_server');
      expect(entry?.serverStatus).toBe('processing');
      expect(entry?.confirmedByServerAt).toBe('2026-08-29T10:05:00.000Z');
      expect(await store.getOutboxItem(entryId)).toBeUndefined();
      // The verdict came from `received_at`, not from reading the English detail string.
      expect(api.getCalls).toBe(1);
    });

    it('blocks a 409 the server means as a refusal', async () => {
      const entryId = await queued();
      api.failDeclare = httpError(409, 'Media … was already declared for a different entry.');
      api.sticky = true;
      api.receivedAt = null;

      await uploads.flush();

      expect(await store.getOutboxItem(entryId)).toMatchObject({
        state: 'blocked',
        failureKind: 'rejected',
      });
    });

    it('retries rather than blocks when the tie-breaking lookup itself fails', async () => {
      // We could not find out which kind of 409 this was. An unresolved ambiguity must never be
      // resolved against the evidence.
      const entryId = await queued();
      api.failDeclare = httpError(409);
      api.failGet = httpError(0);

      await uploads.flush();

      expect(await store.getOutboxItem(entryId)).toMatchObject({
        state: 'failed',
        failureKind: 'offline',
      });
    });

    it('stops at once when `POST /entries` reports the entry already sealed', async () => {
      const entryId = await queued({ photoCount: 3 });
      api.receivedAt = '2026-08-29T09:00:00.000Z';
      api.status = 'awaiting_confirmation';

      await uploads.flush();

      expect((await store.getEntry(entryId))?.status).toBe('confirmed_by_server');
      // No declaration, no PUTs, no completion: the conversation was over before it started.
      expect(api.declared).toHaveLength(0);
      expect(api.put).toHaveLength(0);
      expect(api.completeCalls).toBe(0);
    });
  });

  // ---- Queue discipline -----------------------------------------------------------------------

  describe('the queue', () => {
    it('takes entries in the order they were captured', async () => {
      const first = await queued();
      api.receivedAt = null;
      const second = await queued();

      await uploads.flush();

      expect(api.created.map((request) => request.id)).toEqual([first, second]);
    });

    it('discards an outbox row whose entry is gone, and nothing else', async () => {
      const orphan = crypto.randomUUID();
      await db.outbox.put({
        entryId: orphan,
        state: 'queued',
        seq: 99,
        attempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
        lastError: null,
        failureKind: null,
        createdAt: new Date().toISOString(),
      });

      await uploads.flush();

      expect(await store.getOutboxItem(orphan)).toBeUndefined();
      expect(api.created).toHaveLength(0);
    });

    it('picks up an entry the last process died in the middle of uploading', async () => {
      // The gating defect this spec exists for. `in_flight` is written to disk, but the attempt
      // it describes lives only in a JavaScript task — and on a site that task ends without
      // warning: the phone goes in a pocket and iOS discards the tab, the battery dies, the
      // browser is swiped away. Nothing was reading such a row afterwards: not due, not backlog,
      // not stuck, no retry button — while the pending screen went on saying "Slanje na server"
      // about an entry nothing was sending.
      const entryId = await queued({ photoCount: 1 });
      await store.setOutboxState(entryId, 'in_flight');
      expect((await store.getEntry(entryId))?.status).toBe('uploading');

      // A fresh process: `start()` releases what the previous one abandoned, and the first pass
      // it schedules takes the released row. Run in an injection context because that is where
      // the app initializer calls it from.
      TestBed.runInInjectionContext(() => uploads.start());
      await uploads.flush();

      expect((await store.getEntry(entryId))?.status).toBe('confirmed_by_server');
      expect(await store.getOutboxItem(entryId)).toBeUndefined();
      expect(api.completeCalls).toBe(1);
    });

    it('releases a stranded row even when the entry cannot be sent yet', async () => {
      // Released to `queued`, not straight to success: the point is that it re-enters the queue
      // and is visible there, whatever the network then does with it.
      const entryId = await queued();
      await store.setOutboxState(entryId, 'in_flight');
      online.set(false);

      await store.releaseInFlight();

      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('queued');
      // The attempt that died still counts: a phone killed mid-upload every single time must not
      // look for ever like one that is merely on its first try.
      expect(item?.attempts).toBe(1);
      expect((await store.getEntry(entryId))?.status).toBe('queued');
    });

    it('never ends an attempt with the row still marked in flight', async () => {
      // The same strand inside a live process: if the Dexie write that records a failure throws,
      // `wake()` swallows it and the row would keep a state whose owner has gone away.
      const entryId = await queued();
      api.failCreate = httpError(0);
      const write = store.setOutboxState.bind(store);
      let calls = 0;
      const record = vi.spyOn(store, 'setOutboxState').mockImplementation(async (...args) => {
        calls += 1;
        // Call 1 marks it in flight; call 2 is the one that records the failure, and that is the
        // write we make fail. Call 3 is the guard putting the row back.
        if (calls === 2) {
          throw new Error('QuotaExceededError');
        }
        return write(...args);
      });

      await uploads.flush();
      record.mockRestore();

      const item = await store.getOutboxItem(entryId);
      expect(item?.state).toBe('failed');
      expect(item?.nextAttemptAt).not.toBeNull();
    });

    it('leaves an item that is still backing off alone', async () => {
      const entryId = await queued();
      await store.setOutboxState(entryId, 'failed', {
        failureKind: 'offline',
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      });

      await uploads.flush();

      expect(api.created).toHaveLength(0);
    });
  });
});
