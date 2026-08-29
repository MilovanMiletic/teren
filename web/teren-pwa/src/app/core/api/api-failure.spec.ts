import { HttpErrorResponse } from '@angular/common/http';

import {
  STALLED_AFTER_ATTEMPTS,
  UploadFailure,
  classifyApiError,
  classifyStorageError,
  isTerminal,
} from './api-failure';

/** An `/api` response as Angular delivers it, problem document and all. */
function problem(status: number, detail?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    statusText: 'error',
    url: 'http://localhost:5080/api/entries',
    error: detail ? { title: 'Problem', detail } : null,
  });
}

describe('classifyApiError', () => {
  describe('retryable', () => {
    it('treats a dead network as retryable — Angular reports every one of them as status 0', () => {
      // Airplane mode, DNS failure, a refused connection and a blocked CORS preflight all arrive
      // here identically. None of them is the server's answer, so none of them is a verdict.
      const failure = classifyApiError(problem(0));

      expect(failure.kind).toBe('offline');
      expect(failure.terminal).toBe(false);
    });

    it.each([500, 502, 503, 504, 429, 408])('retries %d', (status) => {
      const failure = classifyApiError(problem(status));

      expect(failure.kind).toBe('server');
      expect(failure.terminal).toBe(false);
    });

    it('retries a 503 from the storage time budget, which is what Retry-After means', () => {
      // `/complete` answers 503 when object storage is slow. The entry keeps whatever state it
      // had and nothing was written — coming back shortly is precisely the right response.
      expect(classifyApiError(problem(503)).terminal).toBe(false);
    });

    it('retries a 500, because the server holds the entry and the row can be repaired', () => {
      // `/complete` answers 500 for one malformed server state (an entry advanced past
      // `received` without a receipt) — a tripwire for B4, currently unreachable. Treating it as
      // terminal would abandon an entry whose JSON the server already has; retrying means it
      // goes through unattended once the row is fixed.
      expect(classifyApiError(problem(500, 'Entry … is in an inconsistent state.')).kind).toBe(
        'server',
      );
      expect(classifyApiError(problem(500)).terminal).toBe(false);
    });

    it('retries a request the client itself abandoned for hanging', () => {
      // A connection that neither answers nor fails holds up the whole serialised upload chain,
      // so the client abandons it. That is a statement about the connection, never about the
      // entry — and from the phone's side it is indistinguishable from being offline.
      const failure = classifyApiError({ name: 'TimeoutError', message: 'Timeout has occurred' });

      expect(failure.kind).toBe('offline');
      expect(failure.terminal).toBe(false);
    });

    it('treats a stalled upload to object storage the same way', () => {
      expect(
        classifyStorageError({ name: 'TimeoutError', message: 'Timeout has occurred' }).terminal,
      ).toBe(false);
    });

    it('retries an error thrown on our side of the network rather than blocking on it', () => {
      const failure = classifyApiError(new TypeError('Failed to read blob'));

      expect(failure.kind).toBe('unknown');
      expect(failure.terminal).toBe(false);
    });
  });

  describe('terminal', () => {
    it('does not retry a 404 — a project the server has never heard of stays unheard of', () => {
      // This is the failure the whole distinction was built for. Before B3 an entry captured
      // against a project id the seeder does not create would retry for ever, and the foreman
      // would read "waiting to upload" over evidence that could never leave the phone.
      const failure = classifyApiError(problem(404, 'Project 6f7a1c1e-… was not found.'));

      expect(failure.kind).toBe('rejected');
      expect(failure.terminal).toBe(true);
    });

    it.each([400, 422])('does not retry %d — the request itself is wrong', (status) => {
      expect(classifyApiError(problem(status)).terminal).toBe(true);
    });

    it.each([401, 403])('does not retry %d — this build cannot become authorised', (status) => {
      const failure = classifyApiError(problem(status));

      expect(failure.kind).toBe('unauthorized');
      expect(failure.terminal).toBe(true);
    });
  });

  it('reads a 409 pessimistically, leaving the sealed-entry case to a lookup', () => {
    // A 409 alone cannot be judged: the server says it both to "your declaration is refused" and
    // to "I already have this entry, sealed". `UploadService.classify` re-reads the entry and
    // looks at `received_at`; this function only supplies the fallback verdict.
    const failure = classifyApiError(problem(409, 'its evidence set is sealed'));

    expect(failure.kind).toBe('rejected');
    expect(failure.status).toBe(409);
  });

  it('carries the server detail for the log without putting it on screen', () => {
    const failure = classifyApiError(
      problem(409, 'Media … was already declared for another entry.'),
    );

    expect(failure.message).toContain('already declared');
  });

  it('passes an already-classified failure through untouched', () => {
    const original = new UploadFailure('insecure_context', 'no subtle crypto');

    expect(classifyApiError(original)).toBe(original);
  });
});

describe('classifyStorageError', () => {
  it('retries a rejected PUT, because a 15-minute URL expires and the next pass re-signs one', () => {
    const failure = classifyStorageError(
      new HttpErrorResponse({ status: 403, statusText: 'Forbidden', url: 'http://minio/…' }),
    );

    expect(failure.kind).toBe('storage');
    expect(failure.terminal).toBe(false);
  });

  it('still calls a dead network offline, so the queue does not blame the object store', () => {
    expect(
      classifyStorageError(new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })).kind,
    ).toBe('offline');
  });
});

describe('the terminal set', () => {
  it('contains only the four answers no retry can change', () => {
    // A phone in a basement for three days, or a staging box down over a weekend, must send when
    // it comes back — so nothing about the far end being unavailable is ever terminal, however
    // often it repeats.
    for (const kind of [
      'rejected',
      'unauthorized',
      'not_configured',
      'insecure_context',
    ] as const) {
      expect(isTerminal(kind)).toBe(true);
    }
    for (const kind of ['offline', 'server', 'storage', 'incomplete', 'unknown'] as const) {
      expect(isTerminal(kind)).toBe(false);
    }
  });

  it('makes long retries visible rather than giving up on them', () => {
    // The queue never abandons a retryable entry; after this many attempts the pending screen
    // stops calling it "trying again" and says it is not getting through. Half an hour of capped
    // backoff: past a lift, a tunnel or a server restart, still inside the working day.
    expect(STALLED_AFTER_ATTEMPTS).toBe(8);
  });
});
