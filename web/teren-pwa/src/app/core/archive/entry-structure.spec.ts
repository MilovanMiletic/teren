import { parseEntryStructure, parseEntryWeather } from './entry-structure';

/**
 * The exact payload the demo seed writes for day 1 (`DemoSeeder.cs`), because the archive is
 * judged on it: it is what the distributor opens on his phone.
 */
const SEEDED = {
  schema_version: 1,
  work_done: [
    {
      description: 'Razvod tople i hladne vode',
      location: '2. sprat, zapadno krilo',
      quantity: { value: 40, unit: 'm' },
    },
  ],
  headcount: { total: 3, roles: [{ role: 'vodoinstalater', count: 3 }] },
  materials: [
    { name: 'PPR cev 25mm', quantity: { value: 40, unit: 'm' }, delivered: true },
    { name: 'PPR fiting', quantity: null, delivered: true },
  ],
  blockers: [],
  hidden_work: [
    { description: 'Razvod cevi u zidovima 2. sprata pre zatvaranja', media_ids: [] },
  ],
  notes: null,
};

describe('parseEntryStructure', () => {
  it('reads the seeded v1 payload without altering a single value', () => {
    const structure = parseEntryStructure(SEEDED)!;

    expect(structure.schemaVersion).toBe(1);
    expect(structure.empty).toBe(false);
    // Content is evidence: the Serbian comes out exactly as it went in, uncorrected and
    // untranslated (PROJECT.md principle 2).
    expect(structure.workDone).toEqual([
      {
        description: 'Razvod tople i hladne vode',
        location: '2. sprat, zapadno krilo',
        quantity: { value: 40, unit: 'm' },
      },
    ]);
    expect(structure.headcount).toEqual({ total: 3, roles: [{ role: 'vodoinstalater', count: 3 }] });
    expect(structure.materials[1]).toEqual({
      name: 'PPR fiting',
      // `"quantity": null` is the extraction saying "he did not give a number", not a zero.
      quantity: null,
      delivered: true,
    });
    expect(structure.hiddenWork).toEqual([
      { description: 'Razvod cevi u zidovima 2. sprata pre zatvaranja', mediaIds: [] },
    ]);
    expect(structure.notes).toBeNull();
  });

  it('reports nothing at all when no extraction has run', () => {
    // Every entry captured before B4 populates `structure`. The common case today, not an edge.
    expect(parseEntryStructure(null)).toBeNull();
    expect(parseEntryStructure(undefined)).toBeNull();
    expect(parseEntryStructure('')).toBeNull();
    expect(parseEntryStructure([])).toBeNull();
  });

  it('separates "extraction found nothing" from "extraction has not run"', () => {
    // Two blank cards, two opposite claims. The screen says different things about them, so the
    // parser has to be able to tell them apart.
    const structure = parseEntryStructure({
      schema_version: 1,
      work_done: [],
      materials: [],
      blockers: [],
      hidden_work: [],
      notes: null,
    })!;

    expect(structure).not.toBeNull();
    expect(structure.empty).toBe(true);
  });

  it('drops what it cannot narrow rather than throwing on a malformed extraction', () => {
    // `structure` is a model's output. A detail screen that threw here would hide the raw
    // transcript — the evidence that is always there when the structure is not.
    const structure = parseEntryStructure({
      schema_version: 'one',
      work_done: [
        { description: 'Štemovanje' },
        { location: 'nowhere' },
        'a string where an object belongs',
        null,
      ],
      headcount: [1, 2, 3],
      materials: { name: 'an object where an array belongs' },
      blockers: [{ description: 'čeka se štemovanje', waiting_on: 'električari' }],
      hidden_work: [{ description: 'cevi u zidu', media_ids: ['a', 42, null] }],
      notes: '   ',
    })!;

    expect(structure.schemaVersion).toBeNull();
    // Only the one item with a description survives; a work item without one is not a work item.
    expect(structure.workDone).toEqual([
      { description: 'Štemovanje', location: null, quantity: null },
    ]);
    expect(structure.headcount).toBeNull();
    expect(structure.materials).toEqual([]);
    expect(structure.blockers).toEqual([
      { description: 'čeka se štemovanje', waitingOn: 'električari' },
    ]);
    expect(structure.hiddenWork[0].mediaIds).toEqual(['a']);
    // Whitespace-only is absent, not a note.
    expect(structure.notes).toBeNull();
  });

  it('treats an empty quantity object as no quantity', () => {
    const structure = parseEntryStructure({
      work_done: [{ description: 'Razvod', quantity: { value: null, unit: null } }],
    })!;

    expect(structure.workDone[0].quantity).toBeNull();
  });

  it('keeps a unit without a number, because "nekoliko metara" is still a unit', () => {
    const structure = parseEntryStructure({
      work_done: [{ description: 'Razvod', quantity: { value: null, unit: 'm' } }],
    })!;

    expect(structure.workDone[0].quantity).toEqual({ value: null, unit: 'm' });
  });

  it('keeps `delivered: false` distinct from an absent flag', () => {
    // "Ordered, not delivered" and "he did not say" are different facts about a material.
    const structure = parseEntryStructure({
      materials: [
        { name: 'Geberit ugradni vodokotlić', delivered: false },
        { name: 'Silikon' },
      ],
    })!;

    expect(structure.materials[0].delivered).toBe(false);
    expect(structure.materials[1].delivered).toBeNull();
  });
});

describe('parseEntryWeather', () => {
  it('reads the seeded weather payload', () => {
    expect(
      parseEntryWeather({
        source: 'open-meteo',
        conditions: 'sunčano',
        temperature_min_c: 19.2,
        temperature_max_c: 30.5,
        precipitation_mm: 0.0,
      }),
    ).toEqual({
      conditions: 'sunčano',
      temperatureMinC: 19.2,
      temperatureMaxC: 30.5,
      precipitationMm: 0,
      source: 'open-meteo',
    });
  });

  it('answers null when there is no reading, so the conditions card stays off the screen', () => {
    expect(parseEntryWeather(null)).toBeNull();
    // A payload carrying only provenance is not a weather reading.
    expect(parseEntryWeather({ source: 'open-meteo' })).toBeNull();
  });
});
