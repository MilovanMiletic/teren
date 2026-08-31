import { Injectable, inject } from '@angular/core';

import { classifyApiError } from '../api/api-failure';
import { EntryResponse } from '../api/api-types';
import { TerenApiClient } from '../api/teren-api.client';
import { FileSaver } from './file-saver';
import { filenameFromContentDisposition, safeFilename } from './report-filename';

/**
 * Why the report did not arrive, in the words the screen is allowed to use.
 *
 * The B3 taxonomy (`core/api/api-failure.ts`) sorts errors by *whether a retry can help*, and it
 * stays the only place that reads a status code. What this type adds is the handful of answers
 * that are specific to this route — and, above all, it refuses to let three completely different
 * facts collapse into one grey "could not download":
 *
 * - **notReady / notReported** — the server is fine and the entry is fine;
 *   the PDF is not there *yet*. Not an error and, emphatically, not "missing".
 * - **missing** — the server genuinely has no such entry.
 * - **offline / server** — the server could not be *asked*. Nothing at all is known about the
 *   report, and the screen must say exactly that.
 *
 * This distinction is not a nicety. C3's review found a 404 rendering identically to an
 * unreachable server on the very screen whose job is proving that evidence exists, and the
 * archive is the screen the *buyer* trusts to win disputes.
 */
export type ReportFailure =
  /** No network, or a connection that hung. Nothing was asked. Retry. */
  | 'offline'
  /** 5xx or 429. **Including 500** — every 5xx is retryable, binding since B3. Retry. */
  | 'server'
  /** `409`, and the entry *is* reported: the PDF is still being produced or sent. Retry shortly. */
  | 'notReady'
  /** `409`, and the entry is not reported at all. There is no report to download yet. */
  | 'notReported'
  /** `404` — the server has no such entry, or it belongs to another company. It never says which. */
  | 'missing'
  /**
   * `409 report_unavailable` — the report **was** sent to the client, and the server cannot
   * produce the file: the object is gone, or its bytes no longer match the recorded checksum.
   *
   * Kept apart from every other 409 because it is the one that must never be dressed up as "try
   * later". Nothing about waiting fixes it, and the useful thing to tell a foreman is the part
   * that is still true: the client has the document.
   */
  | 'unavailable'
  /** 400/422 — the request itself is wrong, and repeating it will not help. */
  | 'rejected'
  /** 401/403 — this build's device token is not accepted. */
  | 'unauthorized'
  /** This build has no server address or no device token. */
  | 'notConfigured'
  /** A `200` with no bytes in it. A broken report is not a report; nothing is saved. */
  | 'empty'
  | 'unknown';

/**
 * Every member of {@link ReportFailure}, as a value rather than as a type.
 *
 * The component builds `archive.report.error.${failure}`, so no scan of string literals can see
 * these keys — which is precisely how `confirm.error.reported` once shipped with no sentence
 * behind it and one code path away from putting a raw translation key in front of a foreman. The
 * `Record` refuses to compile until a new member is listed, and `i18n.spec.ts` refuses to pass
 * until both dictionaries translate it.
 */
const ALL_REPORT_FAILURES: Record<ReportFailure, true> = {
  offline: true,
  server: true,
  notReady: true,
  notReported: true,
  missing: true,
  unavailable: true,
  rejected: true,
  unauthorized: true,
  notConfigured: true,
  empty: true,
  unknown: true,
};

/** Every failure the screen may be asked to name, for the spec that checks it can name them. */
export const REPORT_FAILURES = Object.keys(ALL_REPORT_FAILURES) as readonly ReportFailure[];

export interface ReportResult {
  /** True only when the bytes were fetched *and* handed to the browser. */
  ok: boolean;
  failure: ReportFailure | null;
  /**
   * Whether pressing the button again could plausibly succeed.
   *
   * Drives the button's own words: "try again" over a failure only a person or a fixed server can
   * clear is a lie that costs a foreman five taps.
   */
  retryable: boolean;
  /** What the file was actually saved as. Null unless {@link ok}. */
  filename: string | null;
}

/**
 * Everything on the phone's side of "the PDF is downloadable from the app"
 * (`PROJECT.md` §11, ruling 5).
 *
 * ## Foreground, like confirmation — not an outbox item
 *
 * A download has no evidence to protect and no state to reconcile: the foreman is looking at the
 * screen, wants the document now, and nothing is lost if it fails. So the call is made in the
 * foreground and its outcome is reported plainly, rather than being queued and retried behind his
 * back. Nothing here can alter an entry, which is what keeps the sealed-`reported` record
 * read-only (PROJECT.md principle 2) — this adds a download, not an edit.
 *
 * ## A 409 is never judged alone
 *
 * Binding since B3, and this route needs both halves of it.
 *
 * The route answers `409` to two situations that are opposite sentences on screen: no report has
 * been sent yet, and a report *was* sent whose bytes the server can no longer produce. Nothing on
 * the entry distinguishes them — the second one has a `reported_at` exactly like a healthy
 * report — so they are told apart by the **typed `code`** in the problem document
 * ({@link CONFLICT_UNAVAILABLE}). That is not the thing CLAUDE.md forbids: the rule is never to
 * branch on the server's *English detail string*, because wording changes; a snake_case code the
 * API documents as its contract is the sanctioned alternative to it.
 *
 * The code alone is not enough either, because `report_not_ready` covers both "he has not
 * confirmed the day, so nothing is coming" and "he confirmed it and the report is being sent right
 * now". So the entry is **re-read**, and that half is decided on timestamp columns —
 * `reported_at` and `confirmed_at` — exactly as B3 settled.
 *
 * Reading the code costs one extra async hop, because `responseType: 'blob'` delivers the error
 * body as a `Blob` rather than as parsed JSON. If it cannot be read at all — an older server, a
 * proxy that ate the body — the re-read still runs and the softer, safer sentence wins.
 */
@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly api = inject(TerenApiClient);
  private readonly saver = inject(FileSaver);

  /**
   * Fetch the report and hand it to the browser.
   *
   * `fallbackBase` names the file when the server's own name is unreadable — which is the normal
   * case cross-origin. It carries no translated words on purpose: the report's language is the
   * *project's*, not the phone's, so guessing at it from the UI locale would be wrong in exactly
   * the situation the fallback exists for.
   */
  async download(
    entryId: string,
    fallbackBase: string,
    onProgress?: (fraction: number | null) => void,
  ): Promise<ReportResult> {
    if (!this.api.configured) {
      return failed('notConfigured', false);
    }

    let body: Blob | null;
    let contentDisposition: string | null;
    try {
      ({ body, contentDisposition } = await this.api.downloadReport(entryId, onProgress));
    } catch (error) {
      return this.classify(entryId, error);
    }

    if (!body || body.size === 0) {
      // A 200 with nothing in it would otherwise be saved as a zero-byte PDF that opens in
      // nothing — a silent failure wearing a success's clothes.
      return failed('empty', true);
    }

    const filename = safeFilename(filenameFromContentDisposition(contentDisposition), fallbackBase);
    // Normalised rather than trusted: iOS decides what to do with a file largely from its MIME
    // type, and a blob typed `application/octet-stream` is one it will not open as a document.
    this.saver.save(asPdf(body), filename);

    return { ok: true, failure: null, retryable: false, filename };
  }

  private async classify(entryId: string, error: unknown): Promise<ReportResult> {
    const apiFailure = classifyApiError(error);

    if (apiFailure.status === 409) {
      if ((await conflictCode(error)) === CONFLICT_UNAVAILABLE) {
        // The one 409 the entry cannot answer: a report that went out and whose bytes are gone.
        return failed('unavailable', false);
      }
      return this.resolveConflict(entryId);
    }

    switch (apiFailure.kind) {
      case 'offline':
        return failed('offline', true);
      case 'server':
        return failed('server', true);
      // A revoked device and a forbidden role both mean "the server will not hand over this PDF".
      // The download has no retry that could change either, so they share one sentence — and
      // `unauthenticated` is named explicitly so it cannot fall into `default` and be offered as
      // a retryable unknown.
      case 'unauthenticated':
      case 'unauthorized':
        return failed('unauthorized', false);
      case 'not_configured':
      case 'insecure_context':
        return failed('notConfigured', false);
      case 'rejected':
        // `rejected` covers 400/404/409/422, and only a 404 means "no such entry". Getting this
        // wrong is how a screen ends up announcing that a record does not exist because a
        // parameter was malformed.
        return apiFailure.status === 404 ? failed('missing', false) : failed('rejected', false);
      default:
        return failed('unknown', true);
    }
  }

  /**
   * Decide what a `report_not_ready` meant, from the entry's columns rather than from prose.
   *
   * `confirmed_at` is the hinge. A confirmed day has a report queued or in flight, so "it is being
   * sent, try again shortly" is true and the wait is worth something. An unconfirmed one has
   * nothing coming at all until a person passes the gate, and telling him to wait for a report
   * that will never arrive on its own is precisely the kind of false patience this screen exists
   * not to sell.
   *
   * If the re-read itself fails we do not guess *downwards*. An unresolved conflict is reported as
   * `notReady`: saying "no report has gone out for this day" over an entry whose report is in fact
   * mid-flight would send a foreman to re-do work he has finished.
   */
  private async resolveConflict(entryId: string): Promise<ReportResult> {
    let entry: EntryResponse;
    try {
      entry = await this.api.getEntry(entryId);
    } catch {
      return failed('notReady', true);
    }

    return entry.reported_at || entry.confirmed_at
      ? failed('notReady', true)
      : failed('notReported', false);
  }
}

/**
 * The `code` the API puts on a 409 when a sent report's bytes cannot be produced.
 *
 * A stable snake_case token that the server documents as the contract — deliberately not the
 * English `detail` beside it, which is free to change without notice.
 */
const CONFLICT_UNAVAILABLE = 'report_unavailable';

/**
 * Pull the typed `code` out of an RFC 7807 problem document that arrived as a `Blob`.
 *
 * `responseType: 'blob'` is what makes this necessary: it is the right choice for a multi-megabyte
 * PDF and it means error bodies arrive unparsed. Every failure to read one — not a blob, not
 * JSON, no `code` — answers `null`, which sends the caller to the entry re-read rather than to a
 * guess.
 */
async function conflictCode(error: unknown): Promise<string | null> {
  const body = (error as { error?: unknown } | null)?.error;
  if (!(body instanceof Blob)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await body.text()) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

/** The bytes, told what they are. Re-wrapping is free — the blob's data is not copied. */
function asPdf(body: Blob): Blob {
  return body.type === 'application/pdf' ? body : new Blob([body], { type: 'application/pdf' });
}

function failed(failure: ReportFailure, retryable: boolean): ReportResult {
  return { ok: false, failure, retryable, filename: null };
}
