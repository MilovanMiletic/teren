import { CONFIRM_BANNERS, confirmBanner } from './confirm-banner';

/**
 * The sentence the confirmation screen is allowed to say — specced without a screen, because the
 * decision is the part that was wrong and it is not a rendering concern.
 *
 * The first assertion below is the founder's real entry, reproduced: transcription succeeded
 * ("Snimam test pokušaj za stanbenu zgradu vojvode stepe."), extraction failed because the
 * Anthropic account was out of credit, and the screen announced that nothing could be read from
 * the recording — directly beneath the recording, read out in full.
 */
describe('confirmBanner', () => {
  it('does not claim the recording was unreadable when the words came through', () => {
    // `needs_review` with a transcript means the *structuring* failed, nothing else.
    expect(confirmBanner('needs_review', true, false)).toBe('noStructure');
  });

  it('says the recording could not be read only when there is nothing to show', () => {
    expect(confirmBanner('needs_review', false, false)).toBe('noTranscript');
  });

  it('keeps the ordinary path for a day the model actually extracted', () => {
    expect(confirmBanner('awaiting_confirmation', true, true)).toBe('awaiting');
  });

  it('treats an extraction that produced an empty day as no structure at all', () => {
    // To the person reading the screen, "every section came back blank" and "extraction never
    // ran" are the same thing, and "this is what the system made of your recording" over an empty
    // form is the same lie in a quieter key.
    expect(confirmBanner('awaiting_confirmation', true, false)).toBe('noStructure');
  });

  it('lets a human confirmation win over the pipeline story', () => {
    // He has already vouched for this day; what extraction managed is no longer the headline.
    expect(confirmBanner('confirmed', true, false)).toBe('confirmed');
    expect(confirmBanner('confirmed', true, true)).toBe('confirmed');
  });

  it('never leaves the screen without a sentence, whatever the server says', () => {
    for (const status of ['received', 'processing', 'reported', 'something_new', null]) {
      expect(CONFIRM_BANNERS).toContain(confirmBanner(status, false, false));
      expect(CONFIRM_BANNERS).toContain(confirmBanner(status, true, true));
    }
  });
});
