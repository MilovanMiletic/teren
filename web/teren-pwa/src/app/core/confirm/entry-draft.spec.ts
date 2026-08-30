import {
  draftFromStructure,
  draftIsEmpty,
  emptyDraft,
  isVerbatimCorrected,
  newMaterial,
  newWorkItem,
  parseDraftNumber,
  readStoredDraft,
  toCorrectedPayload,
  verbatimCorrectedPayload,
} from './entry-draft';

/**
 * The editable structure, tested without a screen.
 *
 * What is actually being guarded here is ARCHITECTURE §9.3: the payload this file builds is the
 * `corrected` third of the (transcript, extracted, corrected) triple — the product's eval set and
 * its only record of what extraction got wrong. A payload that dropped a section, invented one,
 * or lost a hidden-work media reference would be wrong months before anybody noticed.
 */
describe('entry draft', () => {
  const extracted = {
    schema_version: 1,
    work_done: [
      {
        description: 'Razvod od kotla do kupatila',
        location: 'zapadno krilo, 2. sprat',
        quantity: { value: 40, unit: 'm' },
      },
    ],
    headcount: { total: 3, roles: [{ role: 'vodoinstalater', count: 3 }] },
    materials: [{ name: 'pipr cevi dvaes 5', quantity: { value: 40, unit: 'm' }, delivered: true }],
    blockers: [{ description: 'čeka se štemovanje', waiting_on: 'električari' }],
    hidden_work: [{ description: 'cevi u zidu pre zatvaranja', media_ids: ['media-1', 'media-2'] }],
    notes: 'sve po planu',
  };

  it('seeds every section from what the model extracted', () => {
    const draft = draftFromStructure(extracted);

    expect(draft.workDone).toHaveLength(1);
    expect(draft.workDone[0].description).toBe('Razvod od kotla do kupatila');
    expect(draft.workDone[0].quantity).toEqual({ value: '40', unit: 'm' });
    expect(draft.headcountTotal).toBe('3');
    expect(draft.roles).toEqual([expect.objectContaining({ role: 'vodoinstalater', count: '3' })]);
    expect(draft.materials[0].name).toBe('pipr cevi dvaes 5');
    expect(draft.blockers[0].waitingOn).toBe('električari');
    expect(draft.hiddenWork[0].mediaIds).toEqual(['media-1', 'media-2']);
    expect(draft.notes).toBe('sve po planu');
  });

  it('round-trips a full day without changing a single value', () => {
    // The property that makes the triple trustworthy: opening an entry and confirming it without
    // touching anything must send back exactly what was extracted, not a re-interpretation of it.
    expect(toCorrectedPayload(draftFromStructure(extracted))).toEqual(extracted);
  });

  it('keeps the hidden-work media references through an edit', () => {
    // The single highest-value link in the product: the photograph that proves what went into the
    // wall. Dropping it on a round trip would silently detach the evidence from the claim.
    const draft = draftFromStructure(extracted);
    draft.hiddenWork[0].description = 'cevi u zidu, jugozapadni ugao';

    const payload = toCorrectedPayload(draft) as { hidden_work: { media_ids: string[] }[] };

    expect(payload.hidden_work[0].media_ids).toEqual(['media-1', 'media-2']);
  });

  it('sends the corrected material name, not the one transcription mangled', () => {
    const draft = draftFromStructure(extracted);
    draft.materials[0].name = 'PPR cev 25';

    const payload = toCorrectedPayload(draft) as { materials: { name: string }[] };

    expect(payload.materials[0].name).toBe('PPR cev 25');
  });

  // ---------------------------------------------------------------- the empty-first path

  it('produces a valid v1 payload from an entry that had no structure at all', () => {
    // The everyday case: extraction never ran, or failed, and the whole record is typed. The
    // payload still has to be a complete v1 document or the server refuses it.
    const draft = emptyDraft();
    draft.notes = 'Zatvoreni šlicevi u kupatilu, radila dvojica.';

    const payload = toCorrectedPayload(draft);

    expect(payload).toEqual({
      schema_version: 1,
      work_done: [],
      headcount: null,
      materials: [],
      blockers: [],
      hidden_work: [],
      notes: 'Zatvoreni šlicevi u kupatilu, radila dvojica.',
    });
  });

  it('always carries schema_version — the server and Postgres both insist on it', () => {
    expect(toCorrectedPayload(emptyDraft())['schema_version']).toBe(1);
  });

  it('always carries every section, so a missing key never reads as an unchecked one', () => {
    const payload = toCorrectedPayload(draftFromStructure(null));

    for (const key of ['work_done', 'headcount', 'materials', 'blockers', 'hidden_work', 'notes']) {
      expect(Object.keys(payload)).toContain(key);
    }
  });

  // ---------------------------------------------------------------------- blank scaffolding

  it('drops the empty rows the screen puts on the page to be filled in', () => {
    const draft = emptyDraft();
    draft.workDone = [newWorkItem(), { ...newWorkItem(), description: '  Šlicevanje  ' }];
    draft.materials = [newMaterial()];

    const payload = toCorrectedPayload(draft) as {
      work_done: { description: string }[];
      materials: unknown[];
    };

    expect(payload.work_done).toHaveLength(1);
    expect(payload.work_done[0].description).toBe('Šlicevanje');
    expect(payload.materials).toEqual([]);
  });

  it('calls a draft with nothing but blank rows empty', () => {
    const draft = emptyDraft();
    draft.workDone = [newWorkItem()];
    draft.notes = '   ';

    expect(draftIsEmpty(draft)).toBe(true);
  });

  it('keeps a row he filled in from the wrong end', () => {
    // "Blank" is every field empty, not "the naming field is empty". These filters used to test
    // the identifying field alone, which made the rest of the row conditional on it: a quantity
    // typed before the name it belongs to was dropped here, the draft then read empty, and the
    // confirmation screen went on offering to send his own words instead — one tap from throwing
    // the numbers away without a word. Rare only because most people type left to right.
    const draft = emptyDraft();
    draft.materials = [{ ...newMaterial(), quantity: { value: '40', unit: 'm2' } }];
    draft.workDone = [{ ...newWorkItem(), location: 'kupatilo' }];

    const payload = toCorrectedPayload(draft) as {
      work_done: unknown[];
      materials: unknown[];
    };

    expect(payload.materials).toEqual([
      { name: null, quantity: { value: 40, unit: 'm2' }, delivered: null },
    ]);
    expect(payload.work_done).toEqual([
      { description: null, location: 'kupatilo', quantity: null },
    ]);
    expect(draftIsEmpty(draft)).toBe(false);
  });

  it('counts a delivery answer as an answer, though nothing was typed', () => {
    // `delivered` is tri-state and starts at "he did not say", so moving it off null is a human
    // saying something — the one field on this screen that carries content without a keystroke.
    const draft = emptyDraft();
    draft.materials = [{ ...newMaterial(), delivered: false }];

    expect(draftIsEmpty(draft)).toBe(false);
  });

  it('does not call a draft with only a note empty', () => {
    // The typed fallback's minimum viable record. If this were "empty" the confirm button would
    // be disabled over a day somebody had just written out by hand.
    const draft = emptyDraft();
    draft.notes = 'Postavljeni radijatori na prvom spratu.';

    expect(draftIsEmpty(draft)).toBe(false);
  });

  // ------------------------------------------------------------------------------- numbers

  it('reads a quantity typed with a comma, which is how Serbian writes one', () => {
    expect(parseDraftNumber('40,5')).toBe(40.5);
    expect(parseDraftNumber(' 12 ')).toBe(12);
    expect(parseDraftNumber('')).toBeNull();
  });

  it('refuses to invent a number out of words', () => {
    // "oko 40" is a note, not a quantity. Reading 40 out of it would be the screen fabricating
    // evidence, which is the one thing it may never do.
    expect(parseDraftNumber('oko 40')).toBeNull();
  });

  it('says "he did not say a number" rather than sending a hollow quantity', () => {
    const draft = emptyDraft();
    draft.workDone = [{ ...newWorkItem(), description: 'Šlicevanje' }];

    const payload = toCorrectedPayload(draft) as { work_done: { quantity: unknown }[] };

    expect(payload.work_done[0].quantity).toBeNull();
  });

  it('does not claim a headcount of zero when nobody said how many people were there', () => {
    expect(toCorrectedPayload(emptyDraft())['headcount']).toBeNull();
  });

  // -------------------------------------------------------------------- defensive reading

  it('survives a stored draft written by a build that shaped it differently', () => {
    const restored = readStoredDraft({
      workDone: [{ description: 'Šlicevanje', quantity: { value: '40', unit: 'm' } }, 'rubbish'],
      materials: null,
      notes: 42,
    });

    expect(restored?.workDone).toHaveLength(1);
    expect(restored?.workDone[0].location).toBe('');
    expect(restored?.materials).toEqual([]);
    expect(restored?.notes).toBe('');
  });

  it('reports "no draft" for a value that is not one', () => {
    expect(readStoredDraft(null)).toBeNull();
    expect(readStoredDraft('a string')).toBeNull();
  });

  it('gives every restored row its own id, so editing a list cannot swap two rows', () => {
    const restored = readStoredDraft({
      materials: [{ name: 'PPR cev 25' }, { name: 'Koleno 25' }],
    });

    expect(restored?.materials[0].id).not.toBe(restored?.materials[1].id);
  });

  // --------------------------------------------------- approving the transcript as the record

  /**
   * The pinned contract the report generator is built against (PROJECT.md §11, founder ruling 3).
   *
   * Every field here is load-bearing somewhere else: `notes` is what the report prints, the empty
   * sections are what stop it claiming a structured day, and `described_verbatim` is what tells
   * the generator to render his description rather than a day on which nothing happened.
   */
  it('sends the transcript as the day, marked as the foreman’s own words', () => {
    const payload = verbatimCorrectedPayload(
      'Snimam test pokušaj za stanbenu zgradu vojvode stepe.',
    );

    expect(payload).toEqual({
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

  it('does not touch a single character of what was said', () => {
    // Raw evidence is never altered (PROJECT.md principle 2), and this path exists precisely so
    // a foreman can stand behind his own words unchanged. Tidying whitespace, joining lines or
    // adding a full stop would all be the app editing the record it claims is his.
    const spoken = '  Zatvoreni šlicevi.\n\nSutra   se malteriše.  ';

    expect(verbatimCorrectedPayload(spoken)['notes']).toBe(spoken);
  });

  /**
   * The distinction the eval set depends on (ARCHITECTURE §9.3).
   *
   * A foreman who taps "copy into notes" and confirms produces the same `notes` string as one who
   * approves the transcript as-is. Byte for byte identical, and two completely different signals:
   * one is a person's independent answer, the other is a person declining to answer because the
   * system failed to ask. Only the flag tells them apart, and without it every transcript-shaped
   * note would replay months later as the model having been agreed with.
   */
  it('is distinguishable from a human typing the very same words', () => {
    const words = 'Zatvoreni šlicevi u kupatilu.';
    const typed = toCorrectedPayload({ ...emptyDraft(), notes: words });
    const approved = verbatimCorrectedPayload(words);

    expect(typed['notes']).toBe(approved['notes']);
    expect(isVerbatimCorrected(approved)).toBe(true);
    expect(isVerbatimCorrected(typed)).toBe(false);
  });

  it('reads back an approval only from a real flag, never from a shape that resembles one', () => {
    expect(isVerbatimCorrected(null)).toBe(false);
    expect(isVerbatimCorrected('described_verbatim')).toBe(false);
    expect(isVerbatimCorrected([{ described_verbatim: true }])).toBe(false);
    // Truthy is not true: a server that ever sent a string here must not be read as an approval.
    expect(isVerbatimCorrected({ described_verbatim: 'true' })).toBe(false);
    expect(isVerbatimCorrected({ described_verbatim: false })).toBe(false);
  });

  // ------------------------------------------------------------ malformed model output

  it('drops extraction rows that carry no description rather than rendering a blank line', () => {
    const draft = draftFromStructure({
      schema_version: 1,
      work_done: [{ description: '', location: 'kupatilo' }, { description: 'Razvod' }],
      materials: [{ name: null }],
    });

    expect(draft.workDone).toHaveLength(1);
    expect(draft.materials).toEqual([]);
  });
});
