import { EntryResponse } from './api-types';
import { SUPERSEDED_AFTER_SEND, isSupersededAfterSend, supersededAfterSend } from './failure-reason';

function entry(overrides: Partial<EntryResponse> = {}): EntryResponse {
  return {
    id: 'entry-1',
    project_id: 'project-1',
    entry_date: '2026-08-29',
    status: 'confirmed',
    created_at: '2026-08-29T12:12:00.000Z',
    received_at: '2026-08-29T12:13:35.000Z',
    reported_at: null,
    failure_reason: null,
    media: [],
    ...overrides,
  } as EntryResponse;
}

/*
 * The one terminal reason this client knows by name, and the distinction that carries the weight:
 * **null is silence, not an answer.**
 *
 * Two callers ask this question of two shapes — the full entry on the record screen, the bare reason
 * on the archive row — and both branch on it to withdraw a control. So the failure mode of a wrong
 * answer is a screen that either offers a door into a gate that can only refuse, or withdraws the
 * cheap remedy from every confirmed day in the product.
 */
describe('supersededAfterSend', () => {
  it('recognises the one reason, exactly', () => {
    expect(supersededAfterSend(entry({ failure_reason: SUPERSEDED_AFTER_SEND }))).toBe(true);
  });

  /**
   * **The guard bites on one value.** A diagnostic reason the server adds later — `report_interrupted`
   * is a real one — must not seal an entry the foreman is still allowed to correct in place.
   */
  it('is false for every other reason', () => {
    for (const reason of ['report_interrupted', 'render_failed', 'superseded', 'unexpected']) {
      expect(supersededAfterSend(entry({ failure_reason: reason })), reason).toBe(false);
    }
  });

  /**
   * `undefined` is an older server that does not send the field; `null` is this server saying
   * nothing is wrong. **Neither is "it is superseded"**, and no entry at all is not either.
   */
  it('reads every kind of silence as false', () => {
    expect(supersededAfterSend(entry({ failure_reason: null }))).toBe(false);
    expect(supersededAfterSend(entry({ failure_reason: undefined }))).toBe(false);
    expect(supersededAfterSend(null)).toBe(false);
    expect(supersededAfterSend(undefined)).toBe(false);
  });
});

describe('isSupersededAfterSend', () => {
  /**
   * The same rule asked of a bare string, for the archive **list** row.
   *
   * There is no `EntryListItemResponse` to hand `supersededAfterSend`, so the predicate is factored
   * rather than duplicated: two spellings of one rule is how one of them rots while the other keeps
   * a screen looking right.
   */
  it('answers the same question the same way', () => {
    expect(isSupersededAfterSend(SUPERSEDED_AFTER_SEND)).toBe(true);
    expect(isSupersededAfterSend('report_interrupted')).toBe(false);
    expect(isSupersededAfterSend(null)).toBe(false);
    expect(isSupersededAfterSend(undefined)).toBe(false);
    expect(isSupersededAfterSend('')).toBe(false);
  });

  /**
   * **And it really is one rule, not two that agree today.**
   *
   * Asserted by driving both through the same set of inputs rather than by reading the source: a
   * future edit that gave the entry-shaped predicate its own comparison would go red here.
   */
  it('is the same rule the entry-shaped predicate applies', () => {
    for (const reason of [
      SUPERSEDED_AFTER_SEND,
      'superseded',
      'report_interrupted',
      '',
      null,
      undefined,
    ]) {
      expect(isSupersededAfterSend(reason), String(reason)).toBe(
        supersededAfterSend(entry({ failure_reason: reason })),
      );
    }
  });

  /**
   * The wire value itself, pinned.
   *
   * It is a code the server compiles in (`ReportFailure`), the client branches on it by name, and a
   * rename on either side is silent: the app would simply stop recognising the one state it has a
   * whole gesture for, and the archive would go back to offering the wasted tap.
   */
  it('is spelled the way the server spells it', () => {
    expect(SUPERSEDED_AFTER_SEND).toBe('superseded_after_send');
  });
});
