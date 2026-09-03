import { HttpErrorResponse } from '@angular/common/http';

/**
 * Why an upload attempt did not finish, and — the only question the loop actually asks — whether
 * trying again can ever change the answer.
 *
 * ## Why this distinction is the whole design
 *
 * An outbox that treats every failure as retryable is worse than one that gives up. A
 * `404 Project not found` or a `409` on a changed media declaration is a permanent answer: the
 * phone will re-send the identical bytes forever, drain the battery, and show the foreman
 * "waiting to upload" over an entry that can never leave the device. He will believe it is on its
 * way for as long as he keeps the app installed.
 *
 * So every failure is sorted into exactly one of three outcomes:
 *
 * - **retryable** — the other end was unavailable or the bytes did not arrive. Back off, try
 *   again, never give up. (No network, 5xx, 429, an interrupted PUT to object storage.)
 * - **terminal** — the server has answered, and it will answer the same way to the same request
 *   for ever. Stop, and *say so on screen*: the entry is not lost, it is stuck, and only a human
 *   can move it. (404, 400, a declaration conflict, an unauthorised device, no secure context.)
 * - **already received** — not a failure at all. A `409` from an entry the server has already
 *   sealed (`received_at` set) means it *has* the evidence; the phone was simply late finding
 *   out. Treated as success, because it is one.
 *
 * The third outcome is why {@link classifyApiError} does not decide a `409` on its own: only a
 * look at the entry's `received_at` can tell "you already sent me this" from "I refuse this".
 *
 * ## Every 5xx is retryable, 500 included
 *
 * There is no "the server is broken, give up" class. `/complete` answers **500** for one
 * malformed server state (an entry whose status advanced without a receipt) — currently
 * unreachable, and kept as a tripwire for B4. Calling that terminal would make the phone abandon
 * an entry whose JSON the server already holds; leaving it retryable means the row is repaired
 * server-side and the next attempt succeeds with nobody touching the phone. The same reasoning
 * covers 502, 503 and 504.
 *
 * ## Long retries are made visible, not abandoned
 *
 * Retrying for ever is only dangerous when it is *silent* — a spinner that looks identical to
 * progress. So the loop never gives up on a retryable failure, and the pending screen instead
 * promotes an item that has been failing past {@link STALLED_AFTER_ATTEMPTS} to a distinct
 * "not getting through" state: still queued, still retrying, no longer pretending to be fine.
 * That keeps principle 3 intact (nothing is abandoned) while removing the lie.
 */
export type FailureKind =
  /** The device or the path to the server has no working network. Retry. */
  | 'offline'
  /** The server is there but unwell — 5xx, 429, 408, 503 from an overloaded object store. Retry. */
  | 'server'
  /** The PUT to object storage did not deliver the bytes. A fresh declare re-signs the URL. Retry. */
  | 'storage'
  /** `/complete` answered `ready: false` — declared objects are not (all) in storage yet. Retry. */
  | 'incomplete'
  /** 400/404/422, or a 409 the server will repeat. The request itself is wrong. **Terminal.** */
  | 'rejected'
  /**
   * **401.** The credential is not accepted *at this moment*: the device was revoked, its token
   * has been replaced, or the phone has not been activated yet. Retry.
   *
   * Deliberately **not** terminal, and this is the difference that keeps a day of evidence alive.
   * A 401 is a statement about *now*, not about the request: an admin un-revokes the device, or
   * the foreman types a new code, and the queue heals with nobody touching a single entry. Made
   * terminal — which is what it was until F1 — one rejected credential wrote every entry captured
   * that morning to `blocked`, and a `blocked` row schedules no wake timer, so the loop went
   * permanently dormant and a restart recovered nothing.
   *
   * ## What a revoked device does now, since 2026-09-03
   *
   * This paragraph used to end "a device that is revoked for good therefore retries at the
   * ten-minute ceiling for ever", which was correct and is no longer what happens. **By founder
   * decision a 401 on a bearer-carrying call signs the phone out**
   * (`core/session/device-refusal.service.ts`): the credential is discarded, `usable()` turns
   * false, and `UploadService` therefore attempts *nothing* rather than retrying at the ceiling.
   * The rows stay in the outbox untouched and start moving again the moment the same worker
   * re-activates.
   *
   * **The classification below is unchanged, and must stay unchanged.** `unauthenticated` is still
   * retryable, and this is not a leftover: the queue must never *abandon* an entry over a
   * credential, because a rejected credential is a statement about now. Made terminal — which is
   * what it was until F1 — one refusal writes a morning's entries to `blocked`, and a `blocked`
   * row schedules no wake timer, so the loop goes permanently dormant and a restart recovers
   * nothing. The sign-out changes who is holding the credential; it does not change what the
   * outbox believes about the work.
   */
  | 'unauthenticated'
  /**
   * **403 only.** The credential is fine and the caller is who he says he is; he may not do this.
   * **Terminal**, because waiting cannot fix a wrong company or a wrong role.
   */
  | 'unauthorized'
  /** This build has no API address or no device token. **Terminal.** */
  | 'not_configured'
  /** `crypto.subtle` is unavailable, so nothing can be hashed. **Terminal.** */
  | 'insecure_context'
  /** Something unrecognised. Retried, because stranding evidence on a guess is the worse error. */
  | 'unknown';

/**
 * Every failure kind, enumerable at runtime and kept complete by the compiler.
 *
 * `Record<FailureKind, true>` is the one construct TypeScript checks for *completeness*, so adding
 * a member to the union above and forgetting it here does not compile. That matters because the
 * kinds are the input to a screen: `pending-page.ts` maps each to a sentence, and a kind with no
 * entry falls back to "Slanje nije uspelo iz nepoznatog razloga" — a foreman told nothing about a
 * failure the classifier had named precisely. `i18n.spec.ts` walks this list against
 * `pending.reason.*` in both dictionaries, the way it already walks `REPORT_FAILURES`.
 *
 * The `true` values carry no meaning — the keys are the point.
 */
const ALL_FAILURE_KINDS: Record<FailureKind, true> = {
  offline: true,
  server: true,
  storage: true,
  incomplete: true,
  rejected: true,
  unauthenticated: true,
  unauthorized: true,
  not_configured: true,
  insecure_context: true,
  unknown: true,
};

/** Every kind the loop can record, for the specs that check each one can be named on screen. */
export const FAILURE_KINDS = Object.keys(ALL_FAILURE_KINDS) as readonly FailureKind[];

/**
 * The four kinds no retry can fix.
 *
 * Each is a statement about *this request* that will hold for as long as the request is the same:
 * the project does not exist, the declaration is refused, this caller may not do this, the origin
 * cannot compute a digest. Everything else — every network failure, every 5xx, every object that
 * has not appeared in storage yet, **and every rejected credential** — stays in the queue.
 *
 * `unauthenticated` is the one that had to be taken *out* of this set (F1). It reads like a
 * permanent answer and is not: it describes the credential's standing at this instant, and the
 * instant changes when a foreman activates a new phone. Left in here it did real damage — see the
 * kind's own doc comment for the morning it cost, and for what a refusal does to the *session*
 * since 2026-09-03, which is a separate matter from what it does to the queue.
 */
const TERMINAL_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'rejected',
  'unauthorized',
  'not_configured',
  'insecure_context',
]);

/**
 * Failed attempts after which the pending screen stops calling it "trying again" and says the
 * entry is not getting through.
 *
 * Eight attempts is roughly half an hour of capped backoff — long past a lift, a tunnel or a
 * server restart, and short enough that a foreman finishing his day still finds out. Nothing
 * changes in the queue at this point: the item keeps its place, keeps retrying, and needs no
 * action. Only the words change, from an implied "any moment now" to the truth.
 */
export const STALLED_AFTER_ATTEMPTS = 8;

export function isTerminal(kind: FailureKind): boolean {
  return TERMINAL_KINDS.has(kind);
}

/** A failed attempt, with the diagnostic detail that never reaches the screen unfiltered. */
export class UploadFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    /** English, for logs and for the outbox's `lastError`. Never rendered to the user. */
    detail: string,
    readonly status: number | null = null,
  ) {
    super(detail);
    this.name = 'UploadFailure';
  }

  get terminal(): boolean {
    return isTerminal(this.kind);
  }
}

/**
 * Sort an `/api` error into a kind.
 *
 * `409` is returned as `'rejected'` here — the pessimistic reading — and the caller is expected
 * to re-read the entry before acting on it, because a sealed entry answers `409` to a late media
 * declaration and that case is a success. See `UploadService.classifyConflict`.
 */
export function classifyApiError(error: unknown): UploadFailure {
  if (error instanceof UploadFailure) {
    return error;
  }

  if (isTimeout(error)) {
    return timedOut('the server did not answer in time');
  }

  if (!(error instanceof HttpErrorResponse)) {
    // A throw from our own code on the way to the network — a blob that would not read, a
    // structured-clone failure. Not the server's verdict, so not terminal.
    return new UploadFailure('unknown', describe(error));
  }

  const status = error.status;

  // Angular reports every network-layer failure as status 0: DNS, refused connection, a CORS
  // preflight the browser blocked, airplane mode. None of them is the server's answer.
  if (status === 0) {
    return new UploadFailure('offline', 'the server could not be reached', 0);
  }

  // 401 and 403 mean opposite things and are the one split F1 exists to make. 401: this
  // credential is not accepted *right now* — an admin un-revokes it, or the foreman types a new
  // code, and the queue heals unattended, so it must stay in the outbox. 403: the credential is
  // accepted and this caller may not do this, which no amount of waiting changes.
  if (status === 401) {
    return new UploadFailure('unauthenticated', detailOf(error) ?? 'credential not accepted', 401);
  }

  if (status === 403) {
    return new UploadFailure('unauthorized', detailOf(error) ?? 'not allowed for this caller', 403);
  }

  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return new UploadFailure('rejected', detailOf(error) ?? `rejected with ${status}`, status);
  }

  if (status === 408 || status === 429 || status >= 500) {
    return new UploadFailure('server', detailOf(error) ?? `server answered ${status}`, status);
  }

  return new UploadFailure('unknown', detailOf(error) ?? `unexpected status ${status}`, status);
}

/**
 * Sort a failed PUT to object storage into a kind.
 *
 * Deliberately more forgiving than {@link classifyApiError}: the presigned URL has a 15-minute
 * TTL, so a `403` here is most often an expired signature, and the cure is another pass — the
 * next attempt asks for a fresh URL. Nothing here is ever terminal, and a `storage` failure that
 * keeps repeating is not abandoned; once the row passes {@link STALLED_AFTER_ATTEMPTS} the
 * pending screen stops calling it "trying again" and says it is not getting through, which is how
 * a repeating failure surfaces without the queue giving up on it.
 */
export function classifyStorageError(error: unknown): UploadFailure {
  if (isTimeout(error)) {
    return timedOut('the upload stopped making progress');
  }
  if (!(error instanceof HttpErrorResponse)) {
    return new UploadFailure('storage', describe(error));
  }
  if (error.status === 0) {
    return new UploadFailure('offline', 'object storage could not be reached', 0);
  }
  return new UploadFailure('storage', `object storage answered ${error.status}`, error.status);
}

/**
 * A connection that hung rather than failed, abandoned by the client's own timeout.
 *
 * Reported as `offline` because that is what it is from the phone's side and what the foreman
 * needs told: nothing arrived. Retryable, obviously — the timeout exists to free the upload
 * chain, not to pass judgement on the entry.
 */
function timedOut(detail: string): UploadFailure {
  return new UploadFailure('offline', detail, null);
}

/** RxJS signals its timeout with a plain object carrying this name; there is no exported class. */
function isTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError';
}

/** The `detail` of an RFC 7807 problem document, when the server sent one. */
function detailOf(error: HttpErrorResponse): string | null {
  const body = error.error as { detail?: unknown; title?: unknown } | string | null;
  if (!body || typeof body === 'string') {
    return typeof body === 'string' && body.trim() ? body.trim().slice(0, 300) : null;
  }
  const detail = typeof body.detail === 'string' ? body.detail : null;
  const title = typeof body.title === 'string' ? body.title : null;
  return (detail ?? title)?.slice(0, 300) ?? null;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
