import { UNRECOGNISED_REASON } from '../../core/platform/platform.service';

/**
 * Every failure code the server can put in a tally, and the sentence for it.
 *
 * ## Why a literal map and not a concatenation
 *
 * The same reason `platform-reason.ts` and `company-reason.ts` are literal maps: `i18n.spec.ts`
 * finds a translation key by **reading the source** for anything shaped like one, so
 * `t('health.reason.' + code)` would hide twenty-nine keys from the guard that exists to stop a
 * raw key reaching a screen. Written out, every one of them is checked in both dictionaries.
 *
 * ## Why the value is a key and not `Record<HealthReason, …>`
 *
 * There is no union to be exhaustive over. The vocabulary lives in `src/Teren.Core/` — two closed
 * sets, `ProcessingFailure` and `ReportFailure`, reflected over at runtime by
 * `FailureVocabulary` — and no compiler joins them to this file. Pretending otherwise with a
 * hand-kept union would buy a false sense of completeness: the union would be just as stale as
 * this map and would additionally make a newer server's code a **type error** rather than
 * something the screen can still render.
 *
 * So the contract is deliberately the weaker, honest one: **a code this map does not know renders
 * as itself.** `health.reason.storageUnavailable` never appears on the glass; `some_new_code`
 * does, in the founder's own eyes, on the screen whose whole job is saying what is wrong. Losing a
 * failure would be the defect; printing it untranslated is a blemish.
 *
 * ## The one thing worth noticing about the contents
 *
 * **`storage_unavailable` and `unexpected` are declared by both vocabularies**, and
 * `superseded_after_send` is a *report* code that the server tallies under `pipeline_failures` —
 * because `entry.failure_reason` is written from both sides. That is why this is one flat map
 * rather than two: the same code legitimately arrives under either heading, and two maps would
 * mean two sentences for one word.
 *
 * Read off `ProcessingFailure.cs` and `ReportFailure.cs` on 2026-09-03.
 */
export const HEALTH_REASON_KEYS: Readonly<Record<string, string>> = {
  // ---- ProcessingFailure (the pipeline) ----
  no_evidence: 'health.reason.noEvidence',
  audio_checksum_mismatch: 'health.reason.audioChecksumMismatch',
  audio_missing: 'health.reason.audioMissing',
  storage_unavailable: 'health.reason.storageUnavailable',
  transcription_not_configured: 'health.reason.transcriptionNotConfigured',
  transcription_failed: 'health.reason.transcriptionFailed',
  transcription_empty: 'health.reason.transcriptionEmpty',
  extraction_not_configured: 'health.reason.extractionNotConfigured',
  extraction_failed: 'health.reason.extractionFailed',
  extraction_invalid: 'health.reason.extractionInvalid',
  processing_interrupted: 'health.reason.processingInterrupted',

  // ---- ReportFailure (the delivery) ----
  no_recipients: 'health.reason.noRecipients',
  recipients_unusable: 'health.reason.recipientsUnusable',
  delivery_not_configured: 'health.reason.deliveryNotConfigured',
  photo_checksum_mismatch: 'health.reason.photoChecksumMismatch',
  photo_missing: 'health.reason.photoMissing',
  render_timeout: 'health.reason.renderTimeout',
  render_failed: 'health.reason.renderFailed',
  time_zone_unknown: 'health.reason.timeZoneUnknown',
  nothing_to_report: 'health.reason.nothingToReport',
  delivery_rejected: 'health.reason.deliveryRejected',
  delivery_unauthorized: 'health.reason.deliveryUnauthorized',
  delivery_failed: 'health.reason.deliveryFailed',
  report_interrupted: 'health.reason.reportInterrupted',
  delivery_custody_unknown: 'health.reason.deliveryCustodyUnknown',
  superseded: 'health.reason.superseded',
  superseded_after_send: 'health.reason.supersededAfterSend',

  // ---- Declared by both ----
  unexpected: 'health.reason.unexpected',

  // ---- Neither: what the server reports for a code it does not declare, and what this client
  // reports for a tally whose reason it could not read. One token, because to a reader they are
  // the same fact.
  //
  // **And that is why its sentence attributes the failure to nobody.** It read "a reason this
  // version of the app does not know", which is true of the second case and false of the first —
  // and the first is the common one: the *server* answers with the literal `unrecognised` for a
  // code its own vocabulary does not declare, and no version of this app could have known it
  // (review, 2026-09-04). A screen that blames the wrong end sends a founder to update a phone
  // when what needs looking at is a deployment.
  [UNRECOGNISED_REASON]: 'health.reason.unrecognised',
};

/**
 * The key for a code, or null when this build has never heard of it.
 *
 * Null is the signal to print the code itself — see the class comment for why that is the right
 * failure mode on this screen rather than a silent drop or a build error.
 */
export function healthReasonKey(code: string): string | null {
  return HEALTH_REASON_KEYS[code] ?? null;
}
