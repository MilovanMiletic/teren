import { TestBed } from '@angular/core/testing';

import { EntryResponse } from '../api/api-types';
import { ArchiveService, RemoteEntry } from '../archive/archive.service';
import { EntryStore } from '../db/entry-store';
import { LocalEntry } from '../db/models';
import { TEREN_DB, TerenDb } from '../db/teren-db';
import { DEMO_PROJECTS } from '../projects/project-source';
import { ProjectService } from '../projects/project.service';
import { CorrectionRefusal, CorrectionService, CorrectionTarget } from './correction.service';

/** The site the demo phone is standing on. */
const HERE = DEMO_PROJECTS[0];

/** A different site of the same company — the one a correction must be filed against. */
const THERE = DEMO_PROJECTS[1];

function localEntry(overrides: Partial<LocalEntry> & Pick<LocalEntry, 'id'>): LocalEntry {
  return {
    projectId: THERE.id,
    projectName: THERE.name,
    capturedAt: '2026-09-01T14:12:00.000Z',
    localDay: '2026-09-01',
    status: 'confirmed_by_server',
    serverStatus: 'reported',
    geo: null,
    audioDurationMs: 41_000,
    photoCount: 2,
    confirmedByServerAt: '2026-09-01T14:13:00.000Z',
    createdAt: '2026-09-01T14:12:00.000Z',
    updatedAt: '2026-09-01T14:12:00.000Z',
    ...overrides,
  };
}

function serverEntry(overrides: Partial<EntryResponse> = {}): EntryResponse {
  return {
    id: 'remote-1',
    project_id: THERE.id,
    entry_date: '2026-08-20',
    status: 'reported',
    created_at: '2026-08-20T13:40:00.000Z',
    received_at: '2026-08-20T13:41:00.000Z',
    reported_at: '2026-08-20T14:06:00.000Z',
    ...overrides,
  } as EntryResponse;
}

describe('CorrectionService', () => {
  let db: TerenDb;
  let store: EntryStore;
  let corrections: CorrectionService;
  let remote: RemoteEntry;
  let remoteReads: string[];

  async function configure(options: { projects?: boolean } = {}): Promise<void> {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    remote = { status: 'ok', entry: null, missing: true };
    remoteReads = [];

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TEREN_DB, useValue: db },
        {
          /*
           * The archive's *read* of one entry, stubbed — and only that.
           *
           * The seam is narrow on purpose. What is under test is the rule about which site a
           * correction inherits, and the shipped `ArchiveService.getEntry` already flattens every
           * network outcome into `{ status, entry, missing }` and never throws
           * (`archive.service.spec.ts` pins that). Stubbing the layer *below* it would put this
           * spec's proof behind two seams instead of one; stubbing the layer above would make it a
           * spec about the stub.
           */
          provide: ArchiveService,
          useValue: {
            getEntry: async (entryId: string): Promise<RemoteEntry> => {
              remoteReads.push(entryId);
              return remote;
            },
          } as unknown as ArchiveService,
        },
      ],
    });

    store = TestBed.inject(EntryStore);
    if (options.projects !== false) {
      await TestBed.inject(ProjectService).load();
    }
    corrections = TestBed.inject(CorrectionService);
  }

  /**
   * The target alone, which is what most of these specs are about.
   *
   * `resolve` answers `{ target }` or `{ target: null, refusal }` — the refusal being the half
   * that decides whether the recording screen offers a retry. The specs that are about *which
   * site a correction inherits* read through this; the ones about the refusal call `resolve`
   * directly, which is the line worth being able to see in the diff.
   */
  async function target(entryId: string): Promise<CorrectionTarget | null> {
    return (await corrections.resolve(entryId)).target;
  }

  /** Why the lookup refused, or null when it did not. */
  async function refusal(entryId: string): Promise<CorrectionRefusal | null> {
    return (await corrections.resolve(entryId)).refusal ?? null;
  }

  afterEach(async () => {
    db.close();
    await db.delete();
    TestBed.resetTestingModule();
  });

  // ---- The site is inherited, and it is inherited from the target -----------------------------

  /**
   * **The one rule of this service, and the reason it exists at all.**
   *
   * `POST /api/entries` accepts `supersedes_entry_id` only when it names an entry of the *same*
   * project; anything else answers `404`. A 4xx is **terminal** in this client's failure taxonomy,
   * so a correction filed against the wrong site would not bounce and heal — it would sit in the
   * outbox `blocked`, and a day of a foreman's work would never leave his phone. That is the worst
   * outcome this product has, and it is one stale site selection away.
   *
   * So the site comes from the target and from nothing else. Here the foreman is standing on `HERE`
   * and the day he is correcting was recorded on `THERE`, which is precisely the case where the two
   * differ.
   */
  it('takes the site from the entry being corrected, never from the selected one', async () => {
    await configure();
    TestBed.inject(ProjectService).select(HERE.id);
    await db.entries.put(localEntry({ id: 'e-1', projectId: THERE.id, projectName: THERE.name }));

    const found = await target('e-1');

    expect(found).not.toBeNull();
    expect(found!.entryId).toBe('e-1');
    expect(found!.project.id).toBe(THERE.id);
    expect(found!.project.name).toBe(THERE.name);
    expect(found!.day).toBe('2026-09-01');

    // …and the selected site really was the other one, so this is a difference and not a match.
    expect(TestBed.inject(ProjectService).selected()?.id).toBe(HERE.id);
    expect(found!.project.id).not.toBe(HERE.id);
  });

  /** A day this phone holds resolves with no network at all — the ordinary case, before the mic. */
  it('answers from the phone without asking the server', async () => {
    await configure();
    await db.entries.put(localEntry({ id: 'e-1' }));

    const found = await target('e-1');

    expect(found?.project.id).toBe(THERE.id);
    expect(remoteReads, 'the server was asked about a day the phone already holds').toEqual([]);
  });

  /**
   * A day recorded on **another** foreman's phone. The archive lists it, because the list is a
   * merge, so a man can reach it — and only the server can say where it belongs.
   */
  it('asks the server about a day this phone never recorded', async () => {
    await configure();
    remote = {
      status: 'ok',
      entry: serverEntry({ id: 'r-1', project_id: THERE.id }),
      missing: false,
    };

    const found = await target('r-1');

    expect(remoteReads).toEqual(['r-1']);
    expect(found).toMatchObject({ entryId: 'r-1', day: '2026-08-20' });
    expect(found?.project.id).toBe(THERE.id);
  });

  // ---- Refusing is a real answer --------------------------------------------------------------

  /**
   * **It must never fall back to the selected site**, and this is the spec that says so.
   *
   * Three situations, one answer: the server could not be asked, the server has never heard of that
   * entry, and the server named a site this device cannot see. Guessing in any of them writes a day
   * that can never be sent, and the guess would be invisible until an entry stopped uploading.
   */
  it('refuses rather than guessing, however the lookup fails', async () => {
    const outcomes: { name: string; answer: RemoteEntry }[] = [
      {
        name: 'the server could not be reached',
        answer: { status: 'offline', entry: null, missing: false },
      },
      {
        name: 'the server has never heard of it',
        answer: { status: 'ok', entry: null, missing: true },
      },
      {
        name: 'the server named a site this device cannot see',
        answer: {
          status: 'ok',
          entry: serverEntry({ project_id: 'a-site-from-another-company' }),
          missing: false,
        },
      },
      {
        name: 'the server named no site at all',
        answer: { status: 'ok', entry: serverEntry({ project_id: undefined }), missing: false },
      },
    ];

    for (const { name, answer } of outcomes) {
      await configure();
      TestBed.inject(ProjectService).select(HERE.id);
      remote = answer;

      expect(await target('r-1'), name).toBeNull();
    }
  });

  /**
   * And the refusal is *specifically* a refusal to substitute the selected site.
   *
   * Worth its own assertion rather than folding into the loop above: `null` is the honest answer,
   * and the failure mode this guards against is a helpful one — returning a target whose project
   * happens to be the one the foreman had picked, which would look right on screen and strand the
   * take in the outbox for ever.
   */
  it('does not hand back the selected site when it cannot establish the target’s', async () => {
    await configure();
    const projects = TestBed.inject(ProjectService);
    projects.select(HERE.id);
    remote = { status: 'offline', entry: null, missing: false };

    const found = await target('r-1');

    expect(found).toBeNull();
    // The selection is untouched and unread-from: nothing about it leaked into the answer.
    expect(projects.selected()?.id).toBe(HERE.id);
  });

  /**
   * **…and the refusal says whether asking again could ever help**, because the screen offers a
   * retry off it.
   *
   * All four used to be one `null` under one sentence blaming the network — *"server nije
   * dostupan … probajte ponovo kada budete imali signal"* — with a "Pokušaj ponovo" button under
   * it. In three of the four the server had already answered, so that button asked the same
   * question and got the same answer for ever, and the sentence sent a foreman who *had* a signal
   * looking for one (review, 2026-09-04).
   */
  it('says whether the refusal is the network or the server’s own answer', async () => {
    const cases: { name: string; answer: RemoteEntry; expected: CorrectionRefusal }[] = [
      {
        name: 'the server could not be reached',
        answer: { status: 'offline', entry: null, missing: false },
        expected: 'unreachable',
      },
      {
        name: 'no server is configured at all',
        answer: { status: 'not_configured', entry: null, missing: false },
        expected: 'unreachable',
      },
      {
        name: 'the server has never heard of it',
        answer: { status: 'ok', entry: null, missing: true },
        expected: 'unresolvable',
      },
      {
        name: 'the server named a site this device cannot see',
        answer: {
          status: 'ok',
          entry: serverEntry({ project_id: 'a-site-from-another-company' }),
          missing: false,
        },
        expected: 'unresolvable',
      },
      {
        name: 'the server named no site at all',
        answer: { status: 'ok', entry: serverEntry({ project_id: undefined }), missing: false },
        expected: 'unresolvable',
      },
    ];

    for (const { name, answer, expected } of cases) {
      await configure();
      remote = answer;

      expect(await refusal('r-1'), name).toBe(expected);
    }
  });

  /** A resolved target carries no refusal at all — the two are never both true. */
  it('names no refusal when it found the site', async () => {
    await configure();
    await db.entries.put(localEntry({ id: 'e-1' }));

    expect(await refusal('e-1')).toBeNull();
  });

  /** An empty id is not a lookup. It never reaches Dexie and it never reaches the network. */
  it('refuses an empty id without reading anything', async () => {
    await configure();

    expect(await target('')).toBeNull();
    expect(await target('   ')).toBeNull();
    expect(remoteReads).toEqual([]);
    // …and never as "come back when you have a signal": no signal produces an id.
    expect(await refusal('')).toBe('unresolvable');
  });

  /**
   * A rejected Dexie read is not an exception this caller may raise.
   *
   * `resolve` runs inside the recording screen's own start-up, before the microphone is opened, so
   * a throw here would tear that down instead of rendering the state the screen already has for
   * "I could not find out". Private mode and a full disk both produce it.
   */
  it('survives a store that will not answer', async () => {
    await configure();
    vi.spyOn(store, 'getEntry').mockRejectedValue(new Error('IndexedDB is not available'));
    remote = {
      status: 'ok',
      entry: serverEntry({ id: 'e-1', project_id: THERE.id }),
      missing: false,
    };

    // Falls through to the server rather than throwing — the store's silence is not a verdict.
    await expect(target('e-1')).resolves.toMatchObject({ entryId: 'e-1' });
  });

  // ---- The project record, and its fallback ---------------------------------------------------

  /**
   * The full project record when the list holds it, so the recording screen can print the address.
   */
  it('hands back the project list’s own record, address included', async () => {
    await configure();
    await db.entries.put(localEntry({ id: 'e-1', projectId: THERE.id }));

    const found = await target('e-1');

    expect(found?.project).toEqual(THERE);
    expect(found?.project.address).not.toBe('');
  });

  /**
   * …and the entry's own denormalised name when it does not — a fallback rather than a failure.
   *
   * The name was copied onto the entry at capture time for exactly this, and an entry must always
   * render even when the project list has changed underneath it. The correctness that matters is
   * `projectId`: the wire only carries the id, and it is still the target's own.
   */
  it('falls back to the name on the entry when the project list has moved on', async () => {
    await configure();
    await db.entries.put(
      localEntry({ id: 'e-1', projectId: 'a-site-no-longer-listed', projectName: 'Stara zgrada' }),
    );

    const found = await target('e-1');

    expect(found?.project).toEqual({
      id: 'a-site-no-longer-listed',
      name: 'Stara zgrada',
      address: '',
    });
  });

  /**
   * A phone with no project list at all still resolves a day it recorded itself.
   *
   * The asymmetry is deliberate and it is the offline case: Dexie holds the entry and the entry
   * holds its own site id and name, so nothing needs the list. A day recorded elsewhere cannot be
   * resolved without it, which is the `null` above.
   */
  it('resolves its own day with no project list loaded', async () => {
    await configure({ projects: false });
    await db.entries.put(localEntry({ id: 'e-1', projectId: THERE.id, projectName: THERE.name }));

    expect(await target('e-1')).toMatchObject({
      entryId: 'e-1',
      project: { id: THERE.id, name: THERE.name },
    });
  });

  /** A day whose site day the server did not give still resolves: the *site* is what is required. */
  it('resolves without a day, because the site is the load-bearing half', async () => {
    await configure();
    remote = {
      status: 'ok',
      entry: serverEntry({ id: 'r-1', project_id: THERE.id, entry_date: undefined }),
      missing: false,
    };

    const found = await target('r-1');

    expect(found?.project.id).toBe(THERE.id);
    expect(found?.day).toBeNull();
  });
});
