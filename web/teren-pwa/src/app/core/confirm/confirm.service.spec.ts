import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { TEST_PROJECT, captureEntry } from '../../testing/capture-fixture';
import { EntryResponse } from '../api/api-types';
import { TerenApiClient } from '../api/teren-api.client';
import { EntryStore } from '../db/entry-store';
import { TEREN_DB, TerenDb } from '../db/teren-db';
import { ConfirmService } from './confirm.service';
import { EntryDraft, emptyDraft } from './entry-draft';

/**
 * A stand-in for `POST /api/entries/{id}/confirm` that behaves the way `Teren.Api` behaves —
 * including the two things this service exists for: it answers `409` both when the entry is
 * already reported and when the pipeline has not finished with it, and the only way to tell those
 * apart is to re-read the entry.
 */
class FakeApi {
  configured = true;

  status = 'awaiting_confirmation';
  reportedAt: string | null = null;

  /** What the last successful confirmation sent. The triple's third column, on the wire. */
  sent: Record<string, unknown> | null = null;
  confirmCalls = 0;
  getCalls = 0;

  failConfirm: unknown = null;
  failGet: unknown = null;

  async confirmEntry(entryId: string, corrected: Record<string, unknown>): Promise<EntryResponse> {
    this.confirmCalls += 1;
    if (this.failConfirm) {
      throw this.failConfirm;
    }
    this.sent = corrected;
    this.status = 'confirmed';
    return this.entry(entryId);
  }

  async getEntry(entryId: string): Promise<EntryResponse> {
    this.getCalls += 1;
    if (this.failGet) {
      throw this.failGet;
    }
    return this.entry(entryId);
  }

  private entry(id: string): EntryResponse {
    return {
      id,
      project_id: TEST_PROJECT.id,
      entry_date: '2026-08-29',
      status: this.status,
      created_at: '2026-08-29T10:00:00.000Z',
      received_at: '2026-08-29T10:05:00.000Z',
      confirmed_at: this.status === 'confirmed' ? '2026-08-29T10:30:00.000Z' : null,
      reported_at: this.reportedAt,
      failure_reason: null,
      media: [],
    };
  }
}

function httpError(status: number, detail?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    statusText: 'error',
    url: 'http://localhost:5080/api/entries/x/confirm',
    error: detail ? { title: 'Problem', detail } : null,
  });
}

describe('ConfirmService', () => {
  let db: TerenDb;
  let store: EntryStore;
  let api: FakeApi;
  let confirmations: ConfirmService;

  const draft = (notes: string): EntryDraft => ({ ...emptyDraft(), notes });

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    api = new FakeApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: TEREN_DB, useValue: db },
        { provide: TerenApiClient, useValue: api as unknown as TerenApiClient },
      ],
    });
    store = TestBed.inject(EntryStore);
    confirmations = TestBed.inject(ConfirmService);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  async function givenEntryWithDraft(notes = 'radila dvojica'): Promise<string> {
    const entry = await captureEntry(store);
    await store.setServerStatus(entry.id, 'awaiting_confirmation');
    await store.saveConfirmDraft(entry.id, draft(notes));
    return entry.id;
  }

  // ------------------------------------------------------------------------- the happy path

  it('sends the human answer as a complete v1 corrected document', async () => {
    const id = await givenEntryWithDraft();

    const result = await confirmations.confirm(id, draft('Postavljeni radijatori'));

    expect(result.ok).toBe(true);
    expect(api.sent).toEqual({
      schema_version: 1,
      work_done: [],
      headcount: null,
      materials: [],
      blockers: [],
      hidden_work: [],
      notes: 'Postavljeni radijatori',
    });
  });

  // -------------------------------------------------- approving the transcript as the record

  it('sends the transcript as the record, flagged as approval rather than typing', async () => {
    const id = await givenEntryWithDraft();

    const result = await confirmations.confirmVerbatim(
      id,
      'Snimam test pokušaj za stanbenu zgradu vojvode stepe.',
    );

    expect(result.ok).toBe(true);
    expect(api.sent).toEqual({
      schema_version: 1,
      work_done: [],
      headcount: null,
      materials: [],
      blockers: [],
      hidden_work: [],
      notes: 'Snimam test pokušaj za stanbenu zgradu vojvode stepe.',
      described_verbatim: true,
    });
  });

  it('clears the local draft when the transcript is approved, same as any confirmation', async () => {
    // The server holds the answer now. A draft left behind would re-seed a form he never filled.
    const id = await givenEntryWithDraft();

    await confirmations.confirmVerbatim(id, 'gotovo za danas');

    expect(await store.getConfirmDraft(id)).toBeUndefined();
  });

  it('classifies a failed verbatim approval exactly as a failed typed one', async () => {
    // One route, one taxonomy. A 500 is retryable on both paths (B3, binding) — a verbatim
    // approval that gave up on a repairable server would abandon the entry for a reason the
    // foreman cannot see or fix.
    const id = await givenEntryWithDraft();
    api.failConfirm = httpError(500);

    const result = await confirmations.confirmVerbatim(id, 'gotovo za danas');

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('server');
    expect(result.retryable).toBe(true);
    // And nothing was thrown away while the server was broken.
    expect(await store.getConfirmDraft(id)).toBeDefined();
  });

  it('brings the local row into line so Home stops calling a confirmed entry unconfirmed', async () => {
    const id = await givenEntryWithDraft();

    await confirmations.confirm(id, draft('gotovo'));

    expect((await store.getEntry(id))?.serverStatus).toBe('confirmed');
  });

  it('drops the local draft only once the server has answered', async () => {
    const id = await givenEntryWithDraft();
    expect(await store.getConfirmDraft(id)).toBeDefined();

    await confirmations.confirm(id, draft('gotovo'));

    expect(await store.getConfirmDraft(id)).toBeUndefined();
  });

  // ------------------------------------------------------------- failures that lose nothing

  it('keeps the draft and reports a retry when the server cannot be reached', async () => {
    const id = await givenEntryWithDraft('pola dana otkucano');
    api.failConfirm = httpError(0);

    const result = await confirmations.confirm(id, draft('pola dana otkucano'));

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('offline');
    expect(result.retryable).toBe(true);
    // The whole promise of the screen: a failed confirmation costs nothing typed.
    expect(await store.getConfirmDraft(id)).toBeDefined();
  });

  it('treats a 500 as retryable, exactly like every other 5xx', async () => {
    // Binding since B3 and easy to get wrong on a write path. Calling a 500 terminal would tell a
    // foreman to retype a day that is still sitting safely on his phone.
    const id = await givenEntryWithDraft();
    api.failConfirm = httpError(500, 'entry has advanced without a receipt');

    const result = await confirmations.confirm(id, draft('gotovo'));

    expect(result.failure).toBe('server');
    expect(result.retryable).toBe(true);
    expect(await store.getConfirmDraft(id)).toBeDefined();
  });

  it('treats 503 and 429 as retryable too', async () => {
    const id = await givenEntryWithDraft();
    for (const status of [429, 502, 503, 504]) {
      api.failConfirm = httpError(status);
      const result = await confirmations.confirm(id, draft('gotovo'));
      expect(result.retryable).toBe(true);
    }
  });

  it('stops on a request the server will refuse again, and still keeps the draft', async () => {
    const id = await givenEntryWithDraft();
    api.failConfirm = httpError(422, 'corrected must carry schema_version.');

    const result = await confirmations.confirm(id, draft('gotovo'));

    expect(result.failure).toBe('rejected');
    expect(result.retryable).toBe(false);
    expect(await store.getConfirmDraft(id)).toBeDefined();
  });

  it('reports an unaccepted device token as terminal', async () => {
    const id = await givenEntryWithDraft();
    api.failConfirm = httpError(401);

    const result = await confirmations.confirm(id, draft('gotovo'));

    expect(result.failure).toBe('unauthorized');
    expect(result.retryable).toBe(false);
  });

  it('says so plainly when this build has no server at all', async () => {
    const id = await givenEntryWithDraft();
    api.configured = false;

    const result = await confirmations.confirm(id, draft('gotovo'));

    expect(result.failure).toBe('notConfigured');
    expect(api.confirmCalls).toBe(0);
  });

  // ------------------------------------------------------------------------- the 409 fork

  it('reads a 409 as "already reported" only after re-reading the entry', async () => {
    const id = await givenEntryWithDraft();
    api.failConfirm = httpError(409, 'was reported and is immutable');
    api.status = 'reported';
    api.reportedAt = '2026-08-29T18:00:00.000Z';

    const result = await confirmations.confirm(id, draft('gotovo'));

    expect(result.failure).toBe('reported');
    expect(result.retryable).toBe(false);
    // The verdict came from `reported_at`, not from the English detail string.
    expect(api.getCalls).toBe(1);
    expect((await store.getEntry(id))?.serverStatus).toBe('reported');
  });

  it('reads the other 409 as "not ready yet", which is retryable and not a refusal', async () => {
    const id = await givenEntryWithDraft();
    api.failConfirm = httpError(409, 'there is nothing to confirm');
    api.status = 'processing';

    const result = await confirmations.confirm(id, draft('gotovo'));

    expect(result.failure).toBe('notReady');
    expect(result.retryable).toBe(true);
    expect(await store.getConfirmDraft(id)).toBeDefined();
  });

  it('does not guess when the conflict cannot be resolved', async () => {
    // Announcing "this entry has been sent and cannot be changed" over one that is merely still
    // processing would tell a foreman his correction is impossible when it is simply early.
    const id = await givenEntryWithDraft();
    api.failConfirm = httpError(409);
    api.failGet = httpError(0);

    const result = await confirmations.confirm(id, draft('gotovo'));

    expect(result.retryable).toBe(true);
    expect(result.failure).not.toBe('reported');
  });

  it('never decides a 409 from the words the server used', async () => {
    // Same prose, opposite verdicts — the client's correctness must not depend on the server's
    // wording, which is free to improve.
    const id = await givenEntryWithDraft();
    const prose = 'Entry is in a state that cannot be confirmed.';

    api.failConfirm = httpError(409, prose);
    api.status = 'processing';
    expect((await confirmations.confirm(id, draft('a'))).failure).toBe('notReady');

    api.failConfirm = httpError(409, prose);
    api.status = 'reported';
    api.reportedAt = '2026-08-29T18:00:00.000Z';
    expect((await confirmations.confirm(id, draft('a'))).failure).toBe('reported');
  });
});
