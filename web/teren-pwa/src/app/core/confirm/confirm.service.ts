import { Injectable, inject } from '@angular/core';

import { EntryResponse } from '../api/api-types';
import { classifyApiError } from '../api/api-failure';
import { TerenApiClient } from '../api/teren-api.client';
import { EntryStore } from '../db/entry-store';
import { EntryDraft, toCorrectedPayload, verbatimCorrectedPayload } from './entry-draft';

/**
 * Why a confirmation did not land, in the words the screen is allowed to use.
 *
 * The B3 taxonomy (`core/api/api-failure.ts`) sorts errors by *whether a retry can help*; this
 * type adds the two answers that are specific to this route and cannot be read off a status code
 * at all. Both come from a `409`, and telling them apart is the whole reason this service exists
 * rather than the component calling the client directly.
 */
export type ConfirmFailure =
  /** No network, or a connection that hung. Nothing was sent. Retry. */
  | 'offline'
  /** 5xx or 429. **Including 500** — see the note below. Retry. */
  | 'server'
  /** The report has already gone out; the entry is sealed and a correction is a new entry. */
  | 'reported'
  /** The pipeline has not finished with this entry yet, so there is nothing to confirm. */
  | 'notReady'
  /** 400/422/404 — the request itself is wrong, and repeating it will not help. */
  | 'rejected'
  /** 401/403 — this build's device token is not accepted. */
  | 'unauthorized'
  /** This build has no server address or no device token. */
  | 'notConfigured'
  | 'unknown';

/**
 * Every member of `ConfirmFailure`, as a value rather than as a type.
 *
 * The union is a compile-time fact; the dictionaries are runtime JSON files. Nothing tied the two
 * together, and `'reported'` duly shipped with no `confirm.error.reported` string behind it — one
 * code path away from putting a raw translation key in front of a foreman. This closes the gap
 * from both ends: `Record<ConfirmFailure, true>` refuses to compile until a newly added member is
 * listed here, and `i18n.spec.ts` refuses to pass until both dictionaries translate it.
 *
 * The `true` values carry no meaning — the keys are the point. A `Record` is used precisely
 * because it is the one construct TypeScript checks for *completeness*; an array of literals
 * would happily be missing one.
 */
const ALL_CONFIRM_FAILURES: Record<ConfirmFailure, true> = {
  offline: true,
  server: true,
  reported: true,
  notReady: true,
  rejected: true,
  unauthorized: true,
  notConfigured: true,
  unknown: true,
};

/** Every failure the screen may be asked to name, for the specs that check it can name them. */
export const CONFIRM_FAILURES = Object.keys(ALL_CONFIRM_FAILURES) as readonly ConfirmFailure[];

export interface ConfirmResult {
  ok: boolean;
  /** The server's view of the entry after a successful confirmation. */
  entry: EntryResponse | null;
  failure: ConfirmFailure | null;
  /**
   * Whether trying the identical request again could succeed.
   *
   * The screen says something different for each, and the difference is not cosmetic: a
   * retryable failure means the typing is safe on the phone and the button is worth pressing
   * again, while a terminal one means only a person (or a fixed server) can move it. Telling a
   * foreman his work is lost when it is merely unsent is the lie the C3 review found twice.
   */
  retryable: boolean;
}

/**
 * The confirmation gate's connection to the server (ROADMAP B5).
 *
 * ## Why this is a foreground action and not an outbox item
 *
 * Everything on the capture path goes through the outbox, because the foreman must be able to
 * record in a basement and walk away. Confirmation is the opposite situation: he is *looking at
 * the screen*, deciding, and the next thing that happens — a PDF in his client's inbox — is
 * something he must not be told has started when it has not. So the call is made in the
 * foreground and its outcome is reported plainly.
 *
 * That is only honest because the typing itself is never at risk: the draft is written to Dexie
 * on every change (`EntryStore.saveConfirmDraft`) and is deleted **only** after the server
 * answers. A failed confirmation therefore loses nothing at all — it leaves an entry that still
 * needs confirming and a draft that is still exactly as he left it, on Home and on this screen.
 *
 * ## Every 5xx is retryable, 500 included
 *
 * Binding since B3 and repeated here because it is easy to get wrong on a write path: there is no
 * "the server is broken, give up" class. A 500 leaves the entry unconfirmed and the draft intact,
 * and the next attempt succeeds once the row is repaired server-side. Calling it terminal would
 * make the screen tell a person to retype work he does not need to retype.
 *
 * ## A 409 is never judged alone
 *
 * The route answers `409` to two different situations: the entry has already been reported (it is
 * immutable — a correction is a new entry), and the pipeline has not finished with it yet (there
 * is nothing to confirm). Those are opposite sentences to put on screen. They are told apart by
 * **re-reading the entry and looking at `reported_at`**, never by parsing the server's English
 * `detail` string — the same rule B3 settled for the sealed-entry 409, for the same reason: a
 * client whose correctness depends on the server's wording breaks the day somebody improves the
 * wording.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly api = inject(TerenApiClient);
  private readonly store = inject(EntryStore);

  /** Send the day as the human left it in the form. */
  async confirm(entryId: string, draft: EntryDraft): Promise<ConfirmResult> {
    return this.send(entryId, toCorrectedPayload(draft));
  }

  /**
   * Approve the transcript itself as the day's record — the one-tap path when the words came
   * through and only the structuring failed (PROJECT.md §11, founder ruling 3).
   *
   * It goes through exactly the same route, the same idempotency and the same failure
   * classification as a typed confirmation, because from the server's side it *is* one: a human
   * answer in the `corrected` column. The only difference is on the wire, and it is deliberate —
   * `described_verbatim` marks this as approval-as-is so the report can render his description
   * rather than an empty structured day, and so the eval set can tell approval from typing
   * (see {@link verbatimCorrectedPayload}).
   *
   * The caller passes the string the screen is showing. Nothing here trims, joins or tidies it:
   * the words are raw evidence and this path exists so a foreman can stand behind them unchanged.
   */
  async confirmVerbatim(entryId: string, transcript: string): Promise<ConfirmResult> {
    return this.send(entryId, verbatimCorrectedPayload(transcript));
  }

  /**
   * The one route both answers take.
   *
   * On success the local row is brought into line — the server's status is written to Dexie so
   * Home stops calling the entry unconfirmed the moment it is confirmed — and the draft is
   * dropped, because the server now holds it. A verbatim approval clears the draft too: there is
   * nothing typed to protect, and leaving a stale one behind would re-seed a form he never filled.
   */
  private async send(entryId: string, corrected: Record<string, unknown>): Promise<ConfirmResult> {
    if (!this.api.configured) {
      return failed('notConfigured', false);
    }

    let entry: EntryResponse;
    try {
      entry = await this.api.confirmEntry(entryId, corrected);
    } catch (error) {
      return this.classify(entryId, error);
    }

    await this.store.setServerStatus(entryId, entry.status);
    // Last, and only now: until this line the phone was the only place the human's answer
    // existed. Deleting it before the server acknowledged would be principle 3 broken on the one
    // screen where the person, not the recorder, produced the content.
    await this.store.clearConfirmDraft(entryId);

    return { ok: true, entry, failure: null, retryable: false };
  }

  private async classify(entryId: string, error: unknown): Promise<ConfirmResult> {
    const apiFailure = classifyApiError(error);

    if (apiFailure.status === 409) {
      return this.resolveConflict(entryId);
    }

    switch (apiFailure.kind) {
      case 'offline':
        return failed('offline', true);
      case 'server':
        return failed('server', true);
      case 'unauthorized':
        return failed('unauthorized', false);
      case 'not_configured':
      case 'insecure_context':
        return failed('notConfigured', false);
      case 'rejected':
        return failed('rejected', false);
      default:
        // Unrecognised. Retryable, for the same reason B3 gives: an unresolved ambiguity must not
        // be resolved against the person's work.
        return failed('unknown', true);
    }
  }

  /**
   * Decide what a `409` meant, from the entry rather than from the prose.
   *
   * If the re-read itself fails we do not guess. An unresolved conflict is reported as retryable:
   * offering "try again" over an entry that is in fact already reported wastes a tap, while
   * announcing "this entry has been sent and cannot be changed" over one that is merely still
   * processing would tell a foreman his correction is impossible when it is simply early.
   */
  private async resolveConflict(entryId: string): Promise<ConfirmResult> {
    let entry: EntryResponse;
    try {
      entry = await this.api.getEntry(entryId);
    } catch {
      return failed('server', true);
    }

    if (entry.reported_at) {
      await this.store.setServerStatus(entryId, entry.status);
      return { ok: false, entry, failure: 'reported', retryable: false };
    }

    await this.store.setServerStatus(entryId, entry.status);
    return { ok: false, entry, failure: 'notReady', retryable: true };
  }
}

function failed(failure: ConfirmFailure, retryable: boolean): ConfirmResult {
  return { ok: false, entry: null, failure, retryable };
}
