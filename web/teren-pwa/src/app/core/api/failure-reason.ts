import { EntryResponse } from './api-types';

/**
 * The one `failure_reason` this client is allowed to recognise by name.
 *
 * The server writes many reasons onto an entry and almost all of them are diagnostics: a person
 * reads them in the log table, a screen never branches on them. This one is different, and the
 * difference is the reason this file exists rather than a string comparison at a call site.
 *
 * ## What the server means by it
 *
 * A report is `sent` the moment the relay takes custody, and `reported_at` is stamped **only if
 * the entry still holds the document that was rendered** (ARCHITECTURE §6, report state machine).
 * Zero rows on that conditional stamp means a person changed the record after the relay already
 * had it — so the client has a report describing a day the contractor's own archive no longer
 * describes. The server keeps the report row truthfully `sent`, refuses to seal the entry, and
 * writes this reason.
 *
 * **It is terminal.** `ux_report_entry_id` plus the absence of any `sent → sending` transition
 * means the newer content can never get a report of its own, whatever anyone presses.
 *
 * ## Why the PWA has to know
 *
 * Because the entry it lands on is `confirmed` with `reported_at` still null, which is precisely
 * the shape `canRevise` (`core/db/models.ts`) reads as "he may still change his mind". Without
 * this constant the archive offered the way back into the gate, the gate rendered a form, the
 * confirmation succeeded, the report pass wrote the same reason back — and the foreman went round
 * that loop for ever with nothing on any screen naming the cause. Reading one field is what turns
 * a silent dead end into a sentence.
 */
export const SUPERSEDED_AFTER_SEND = 'superseded_after_send';

/**
 * Whether this entry was changed after its report had already left the building.
 *
 * Takes the whole entry rather than the reason string, so no caller has to remember that a null
 * `remote` (the server was not asked) is *not* an answer to this question — it is silence, and
 * silence must leave every other screen behaving exactly as it did before.
 */
export function supersededAfterSend(entry: EntryResponse | null | undefined): boolean {
  return entry?.failure_reason === SUPERSEDED_AFTER_SEND;
}
