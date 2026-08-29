/**
 * Which sentence the confirmation screen is entitled to put above the day.
 *
 * ## Why this is a module and not an inline `switch`
 *
 * It used to be an inline switch on the server status, and it shipped a lie. `needs_review` was
 * read as "the recording could not be read", so an entry whose transcription had *succeeded* and
 * whose words were printed two centimetres higher on the same screen was captioned **"Nothing
 * could be read from the recording — write down what was done, using your own words below."**
 * The founder met that on a real entry: the transcript was perfect and extraction had merely run
 * out of Anthropic credit.
 *
 * The mistake was treating one status as one situation. `needs_review` is the pipeline's word for
 * *something downstream failed*, and it covers two unrelated days:
 *
 * - the recording could not be turned into words at all, and typing is the only way forward;
 * - the words are right there and correct, and only the structuring failed.
 *
 * Those need opposite sentences and opposite actions, so the decision is made from the **facts**
 * — is there a transcript, is there a structure — rather than from the status label that happens
 * to cover both. The status is consulted for one thing only: whether a human has already
 * confirmed. That is the same class of defect as C3's "not found" standing in for "could not be
 * asked" and B5's draft-saved comment: a screen claiming to know something it does not.
 */

/** What the screen is entitled to say about this entry. One member, one honest sentence. */
export type ConfirmBanner =
  /** Extraction produced a day. The normal path: check it and correct what is wrong. */
  | 'awaiting'
  /**
   * The words came through; the structuring did not. His own words are on screen and correct —
   * so the screen must say *that*, and offer the one-tap path that sends them as the record.
   */
  | 'noStructure'
  /** No transcript at all: the recording genuinely could not be read. Typing is the only way on. */
  | 'noTranscript'
  /** A human has already vouched for this day. Still correctable until the report goes out. */
  | 'confirmed';

/**
 * Every member of {@link ConfirmBanner}, as a value rather than as a type.
 *
 * The same construction as `CONFIRM_FAILURES` in `confirm.service.ts`, for the same reason: the
 * template builds `confirm.banner.<key>.title` by concatenation, so no scan of string literals
 * can see the keys it produces. A `Record<ConfirmBanner, true>` refuses to compile when a member
 * is added without being listed, and `i18n.spec.ts` refuses to pass until both dictionaries can
 * name it — which is what stops a raw translation key appearing in front of a foreman.
 */
const ALL_CONFIRM_BANNERS: Record<ConfirmBanner, true> = {
  awaiting: true,
  noStructure: true,
  noTranscript: true,
  confirmed: true,
};

/** Every banner the screen may show, for the specs that check it can name them. */
export const CONFIRM_BANNERS = Object.keys(ALL_CONFIRM_BANNERS) as readonly ConfirmBanner[];

/**
 * Decide from what is actually true of the entry, never from the status alone.
 *
 * `hasStructure` means *the extraction produced a day with something in it* — not merely that the
 * column is non-null. An extraction that returned every section empty is, to the person reading
 * the screen, indistinguishable from one that never ran, and captioning it "this is what the
 * system made of your recording" over an empty form would be the same lie in a quieter key.
 */
export function confirmBanner(
  serverStatus: string | null,
  hasTranscript: boolean,
  hasStructure: boolean,
): ConfirmBanner {
  if (serverStatus === 'confirmed') {
    return 'confirmed';
  }
  if (hasStructure) {
    return 'awaiting';
  }
  return hasTranscript ? 'noStructure' : 'noTranscript';
}
