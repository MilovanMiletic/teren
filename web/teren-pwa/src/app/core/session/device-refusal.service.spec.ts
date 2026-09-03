import { HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { environment } from '../../../environments/environment';
import { guardedRoutes } from '../../testing/route-harness';
import { captureEntry } from '../../testing/capture-fixture';
import { waitUntil } from '../../testing/flush';
import { UploadFailure } from '../api/api-failure';
import { TerenApiClient } from '../api/teren-api.client';
import { COMPANY_GATEWAY } from '../company/company-gateway';
import { CompanyService } from '../company/company.service';
import { EntryStore } from '../db/entry-store';
import { TEREN_DB, TerenDb } from '../db/teren-db';
import { AudioRecorderService, RecorderState } from '../media/audio-recorder.service';
import { ActionLogService } from '../telemetry/action-log.service';
import { ACTIONS } from '../telemetry/actions';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from './admin-session';
import { AdminSessionService } from './admin-session.service';
import { DEVICE_REFUSAL_STORAGE_KEY, readDeviceRefusal } from './device-refusal';
import { DeviceRefusalService } from './device-refusal.service';
import { SESSION_STORAGE_KEY, Session } from './session';
import { SessionService } from './session.service';

/**
 * **A phone whose credential the server refuses signs itself out** (founder decision, 2026-09-03).
 *
 * These specs are written against the shape of the defect rather than against the implementation,
 * because the defect had four independent hiding places and every one of them was green:
 * `EntryStatusRefresher` swallowed the 401 by documented design, `requiresDevice` never asks about
 * revocation, the outbox-derived notice needs eight failed attempts *and* a queued entry, and with
 * an empty outbox — the ordinary case — nothing in the product ever said a word.
 *
 * The four that are mutation-proven, and what removing each costs:
 *
 * - **the device-gated check** — without it, revoking a foreman's phone from `/company` throws the
 *   founder off the screen he is administering and onto a foreman's join-by-code page.
 * - **the recorder deferral** — without it, a poll's 401 landing mid-sentence navigates away from
 *   `/record` and the live `MediaRecorder` dies with the screen. That is the only thing in this
 *   product that is not already on disk.
 * - **the 403 exclusion** — without it, a role refusal signs a man out and asks him to prove who
 *   he is, which was never in question.
 * - **"never Dexie"** — without it, PROJECT.md principle 3 is gone and a day of unsent evidence
 *   goes with a credential.
 */

/**
 * Where the API lives in this build. **Read from the environment, never written out.**
 *
 * `ng test` applies the same `fileReplacements` as `ng serve`, so the base URL here is the dev
 * machine's `http://localhost:5080` while production is the empty string (same origin). A spec
 * that spelled either one out would pass on one configuration and fail on the other for a reason
 * that has nothing to do with credentials.
 */
const API = environment.apiBaseUrl.replace(/\/+$/, '');

/** A complete session — every field `readStoredSession()` insists on. */
function session(overrides: Partial<Session> = {}): Session {
  return {
    token: 'trn_d_the-phone-the-server-refuses',
    deviceId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    username: 'zoran.jovanovic',
    displayName: 'Zoran Jovanović',
    companyId: '33333333-3333-3333-3333-333333333333',
    companyName: 'Gradnja d.o.o.',
    activatedAt: '2026-09-01T06:00:00.000Z',
    ...overrides,
  };
}

/** A live company-admin session, so the founder's dual-credential browser can be reproduced. */
function adminSession(): AdminSession {
  return {
    token: 'trn_s_the-office-console',
    expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
    role: 'company_admin',
    userId: '44444444-4444-4444-4444-444444444444',
    displayName: 'Petar Petrović',
    companyId: '33333333-3333-3333-3333-333333333333',
    companyName: 'Gradnja d.o.o.',
    signedInAt: '2026-09-02T09:00:00.000Z',
  };
}

/** One recorded action, plus the fact the ordering depends on. */
interface Recorded {
  action: string;
  facts: unknown;
  /** Whether the credential was still on disk when the log was told. It has to be. */
  sessionStillStored: boolean;
}

describe('a phone whose credential the server refuses', () => {
  let db: TerenDb;
  let http: HttpTestingController;
  let api: TerenApiClient;
  let sessions: SessionService;
  let admins: AdminSessionService;
  let router: Router;
  let recorderState: ReturnType<typeof signal<RecorderState>>;
  let recorded: Recorded[];
  /** How the mocked company gateway answers `listWorkers` — the admin half of the split. */
  let adminGatewayFails: HttpErrorResponse | null;

  /**
   * The app as a refused phone meets it: a real client over a mocked transport, the **real** route
   * table (paths, order and guards, with the lazy screens stubbed), a real Dexie, and stubs for
   * the two collaborators whose real selves would drag a microphone and a network into a spec
   * about a credential.
   *
   * `API_CONFIG` is deliberately **not** provided, so the default root factory runs: the bearer
   * comes from `SessionService` through its live getter, exactly as in the shipped app. That is
   * what makes the stale-credential check below a real test rather than a test of a fixture.
   */
  async function setUp(options: { admin?: boolean; recorder?: RecorderState } = {}): Promise<void> {
    localStorage.clear();
    TestBed.resetTestingModule();

    // Written before anything is injected: both session services read `localStorage` during
    // construction, which is the property the route gates are built on.
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()));
    if (options.admin) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(adminSession()));
    }

    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    recorderState = signal<RecorderState>(options.recorder ?? 'idle');
    recorded = [];
    adminGatewayFails = null;

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(guardedRoutes()),
        { provide: TEREN_DB, useValue: db },
        {
          provide: AudioRecorderService,
          useValue: { state: recorderState.asReadonly() } as unknown as AudioRecorderService,
        },
        {
          provide: ActionLogService,
          useValue: {
            record: (action: string, facts: unknown) =>
              recorded.push({
                action,
                facts,
                // Read off disk rather than from the signal: the point is that the row the log
                // files an event under still exists at the moment it is told.
                sessionStillStored: localStorage.getItem(SESSION_STORAGE_KEY) !== null,
              }),
          } as unknown as ActionLogService,
        },
        {
          provide: COMPANY_GATEWAY,
          useValue: {
            listWorkers: () =>
              adminGatewayFails ? Promise.reject(adminGatewayFails) : Promise.resolve({}),
          } as never,
        },
      ],
    });

    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(TerenApiClient);
    sessions = TestBed.inject(SessionService);
    admins = TestBed.inject(AdminSessionService);
    router = TestBed.inject(Router);
    // Constructed eagerly so its deferral effect exists before the first refusal, exactly as it
    // does in the app (`TerenApiClient` injects it).
    TestBed.inject(DeviceRefusalService);
  }

  afterEach(async () => {
    localStorage.clear();
    db.close();
    await db.delete();
  });

  /** A 401 answered to one `GET /api/projects`, driven through the real `get()` funnel. */
  async function refuseListProjects(): Promise<void> {
    const pending = api.listProjects().catch(() => undefined);
    http.expectOne(`${API}/api/projects`).flush(
      { title: 'Unauthorized' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await pending;
    TestBed.tick();
  }

  /**
   * Run every effect and every queued task to exhaustion, so an *absence* asserted below is a real
   * absence rather than a race the spec happened to win.
   *
   * **Macrotask turns, not microtask ones, and that is the whole value of this helper.** A router
   * navigation does not finish inside a chain of `Promise.resolve()`; an earlier draft of these
   * specs settled with microtasks alone and **every negative assertion was vacuous** — removing
   * the device-gated check from the service left the whole suite green, because the navigation the
   * mutation caused had not resolved yet when the assertion ran. Caught by mutation-testing the
   * specs themselves, which is the only thing that could have caught it.
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 6; turn += 1) {
      TestBed.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Any status, on the same call — for the answers that must change nothing. */
  async function answerListProjects(status: number): Promise<void> {
    const pending = api.listProjects().catch(() => undefined);
    http.expectOne(`${API}/api/projects`).flush({ title: 'no' }, { status, statusText: 'no' });
    await pending;
    TestBed.tick();
  }

  // ---- Detection at the four funnels ----------------------------------------------------------

  describe('detection', () => {
    /**
     * All four bearer-carrying funnels, each driven through the public method that uses it.
     *
     * `bearer-refusal.spec.ts` proves no *fifth* funnel can appear without the wrapper; this
     * proves the wrapper actually works on the four that exist, including the two blob downloads
     * that build their own requests because `responseType: 'blob'` cannot go through `get()`.
     */
    const funnels: { name: string; call: () => Promise<unknown>; url: string }[] = [
      { name: 'get', call: () => api.listProjects(), url: `${API}/api/projects` },
      {
        name: 'post',
        call: () => api.createEntry({ id: 'e' } as never),
        url: `${API}/api/entries`,
      },
      {
        name: 'downloadReport',
        call: () => api.downloadReport('55555555-5555-5555-5555-555555555555'),
        url: `${API}/api/entries/55555555-5555-5555-5555-555555555555/report`,
      },
      {
        name: 'fetchMedia',
        call: () =>
          api.fetchMedia('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666'),
        url: `${API}/api/entries/55555555-5555-5555-5555-555555555555/media/66666666-6666-6666-6666-666666666666`,
      },
    ];

    for (const funnel of funnels) {
      it(`signs the phone out on a 401 from ${funnel.name}()`, async () => {
        await setUp();
        await router.navigateByUrl('/');

        const pending = funnel.call().catch(() => undefined);
        http.expectOne(funnel.url).flush(null, { status: 401, statusText: 'Unauthorized' });
        await pending;
        TestBed.tick();

        expect(sessions.session()).toBeNull();
        expect(sessions.usable()).toBe(false);
        expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
      });
    }

    /**
     * A screen's load fires several calls at once and a refused phone gets a 401 for each.
     *
     * Home alone polls the entry list, reads the project list and can be downloading a report; on
     * a revoked phone that is three refusals inside a tick. Three sign-outs would mean three log
     * lines and — worse — three navigations, which in a router is a race about which one wins.
     */
    it('signs out exactly once when a whole screen is refused at the same moment', async () => {
      await setUp();
      await router.navigateByUrl('/');

      const calls = [
        api.listProjects().catch(() => undefined),
        api.getMe().catch(() => undefined),
        api.getEntry('55555555-5555-5555-5555-555555555555').catch(() => undefined),
      ];
      for (const request of http.match(() => true)) {
        request.flush(null, { status: 401, statusText: 'Unauthorized' });
      }
      await Promise.all(calls);
      TestBed.tick();

      expect(sessions.session()).toBeNull();
      expect(recorded).toHaveLength(1);
    });

    /**
     * **The 403 exclusion.** Mutation-proven: drop the `unauthenticated` test in
     * `DeviceRefusalService.report` and this goes red on the first status in the list.
     *
     * Each of these is a statement about something other than who this phone is. A 403 says the
     * caller is known and may not do this — typing a code cannot fix a wrong role, and offering it
     * as the remedy is the app claiming to know something it does not. A 5xx says the server is
     * unwell. A 0 says nothing reached it at all, which on this product's connection is Tuesday.
     */
    for (const status of [403, 500, 503, 0, 404, 409, 429]) {
      it(`leaves the credential alone on a ${status}`, async () => {
        await setUp();
        await router.navigateByUrl('/');

        await answerListProjects(status);

        expect(sessions.session()).not.toBeNull();
        expect(localStorage.getItem(SESSION_STORAGE_KEY)).not.toBeNull();
        expect(readDeviceRefusal()).toBeNull();
        expect(recorded).toEqual([]);
        expect(router.url).toBe('/');
      });
    }

    /**
     * The two failure kinds that never come from an HTTP status at all.
     *
     * `not_configured` and `insecure_context` are raised by this app's own code before a request
     * exists — no credential in the build, or a `crypto.subtle` that is unavailable because the
     * origin is not secure. Neither says anything about a credential the server has seen, and the
     * second is the more dangerous to get wrong: an installed PWA opened over plain http would
     * sign a foreman out of a phone nobody has touched.
     */
    for (const kind of ['not_configured', 'insecure_context', 'unauthorized'] as const) {
      it(`leaves the credential alone on a '${kind}' failure`, async () => {
        await setUp();
        await router.navigateByUrl('/');

        TestBed.inject(DeviceRefusalService).report(new UploadFailure(kind, 'raised locally'));
        await settle();

        expect(sessions.session()).not.toBeNull();
        expect(readDeviceRefusal()).toBeNull();
        expect(router.url).toBe('/');
      });
    }

    /**
     * An answer about a credential this phone has already replaced.
     *
     * The window is real: an attempt starts, the man is signed out, he types a fresh code, and the
     * old attempt's 401 arrives afterwards. Acted on, it would sign him out seconds after he had
     * fixed it — and he would be back on the code screen believing the code he had just used was
     * bad.
     */
    it('ignores a refusal that describes a credential it no longer holds', async () => {
      await setUp();
      await router.navigateByUrl('/');

      const pending = api.listProjects().catch(() => undefined);
      const request = http.expectOne(`${API}/api/projects`);
      expect(request.request.headers.get('Authorization')).toBe(`Bearer ${session().token}`);

      // He re-activated while that attempt was in flight.
      sessions.adopt(session({ token: 'trn_d_the-new-phone' }));

      request.flush(null, { status: 401, statusText: 'Unauthorized' });
      await pending;
      TestBed.tick();

      expect(sessions.session()?.token).toBe('trn_d_the-new-phone');
      expect(recorded).toEqual([]);
      expect(router.url).toBe('/');
    });
  });

  // ---- The two credentials stay apart ---------------------------------------------------------

  describe('the two credentials', () => {
    /**
     * **The founder's browser is the demo phone and the office console at once**, and CLAUDE.md
     * records what that has already cost: `/company/profile` describing Zoran to Petar because one
     * call went out with the wrong bearer.
     */
    it('does not touch the admin session when the device credential is refused', async () => {
      await setUp({ admin: true });
      await router.navigateByUrl('/');

      await refuseListProjects();

      expect(sessions.session()).toBeNull();
      expect(admins.signedIn()).toBe(true);
      expect(localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).not.toBeNull();
    });

    it('does not touch the device session when an admin call is refused', async () => {
      await setUp({ admin: true });
      await router.navigateByUrl('/company');

      adminGatewayFails = new HttpErrorResponse({ status: 401, statusText: 'Unauthorized' });
      const result = await TestBed.inject(CompanyService).listWorkers();

      // The admin half behaves exactly as it did — that is `CompanyService.classify`'s job.
      expect(result.status).toBe('signedOut');
      expect(admins.signedIn()).toBe(false);
      // …and the phone is untouched. A foreman-owner's device credential is not evidence that his
      // office sign-in expired, and taking it would cost him the record button for a session
      // timeout on a different key.
      expect(sessions.session()).not.toBeNull();
      expect(readDeviceRefusal()).toBeNull();
    });
  });

  // ---- Where he is standing -------------------------------------------------------------------

  describe('leaving the screen', () => {
    it('takes him to Welcome when he is standing on a device-gated screen', async () => {
      await setUp();
      await router.navigateByUrl('/');

      await refuseListProjects();

      await waitUntil(() => router.url === '/welcome', {
        describe: 'the navigation to /welcome',
        onTick: () => TestBed.tick(),
      });
      // No `?next=`: he is not coming back in a moment with the same credential, and the entry he
      // was looking at may not be his to see once he has joined again.
      expect(router.url).toBe('/welcome');
    });

    it('takes him to Welcome from the archive too, not only from Home', async () => {
      await setUp();
      await router.navigateByUrl('/diary');

      await refuseListProjects();

      await waitUntil(() => router.url === '/welcome', {
        describe: 'the navigation to /welcome',
        onTick: () => TestBed.tick(),
      });
    });

    /**
     * **The device-gated check, and the case it exists for.** Mutation-proven: delete
     * `if (!this.onDeviceGatedScreen()) return;` and this spec goes red with `router.url` at
     * `/welcome`.
     *
     * This is the founder revoking a foreman's phone from the office screen on the browser that is
     * *also* the demo phone. The revoke succeeds, `/company` keeps working — it runs on the admin
     * bearer — and the device session is quietly correct about being dead. Throwing him onto a
     * join-by-code screen mid-administration would look exactly like the app crashing on a
     * successful action.
     */
    it('stays where he is when the screen he is on is not gated on this phone', async () => {
      await setUp({ admin: true });
      await router.navigateByUrl('/company');
      expect(router.url).toBe('/company');

      await refuseListProjects();

      // The credential is still gone — it is dead whatever screen he happens to be looking at.
      expect(sessions.session()).toBeNull();
      // Settled, so this is an absence rather than a race: the navigation, if there were one,
      // would have resolved by now.
      await settle();
      expect(router.url).toBe('/company');
    });

    /**
     * The by-reference reading of the guard, pinned where a rename would break it.
     *
     * `/activate` is ungated by design (F4) and `/company` is gated on the *admin* credential, so
     * neither is a device screen; `/` and every screen inside the app are. Asserted through the
     * real table rather than a list of paths, which is the whole point — a path list here would be
     * the F4b defect in a new costume.
     */
    it('reads the guard off the route table rather than a list of paths', async () => {
      for (const [url, leaves] of [
        ['/', true],
        ['/diary', true],
        ['/pending', true],
        ['/profile', true],
        ['/activate', false],
        ['/company', false],
      ] as [string, boolean][]) {
        await setUp({ admin: true });
        await router.navigateByUrl(url);
        expect(router.url, `navigating to ${url}`).toBe(url);

        await refuseListProjects();

        if (leaves) {
          await waitUntil(() => router.url === '/welcome', {
            describe: `${url} to be left for /welcome`,
            onTick: () => TestBed.tick(),
          });
        } else {
          await settle();
          expect(router.url, `${url} must not be left`).toBe(url);
        }
      }
    });
  });

  // ---- The microphone -------------------------------------------------------------------------

  describe('while the microphone is live', () => {
    /**
     * **The recorder deferral.** Mutation-proven: delete the `if (this.recording())` branch in
     * `leaveDeviceScreen()` and this goes red — the navigation happens while the state is
     * `recording`, which in the app means the live `MediaRecorder` is destroyed with the screen.
     *
     * `core/update/app-update.service.ts` makes the argument in full and it holds here word for
     * word: everything else this app has is in Dexie before it is anywhere else, and thirty
     * seconds of speech is the one thing that is not. The *credential* still goes immediately —
     * it is dead either way, and `usable()` false is what stops the upload loop attempting
     * anything — so nothing is being kept alive here except the screen.
     */
    for (const state of ['starting', 'recording', 'stopping'] as RecorderState[]) {
      it(`does not navigate while the recorder is ${state}`, async () => {
        await setUp({ recorder: state });
        await router.navigateByUrl('/record');

        await refuseListProjects();
        await settle();

        expect(router.url).toBe('/record');
        // The credential is not kept. Only the screen is.
        expect(sessions.session()).toBeNull();
      });
    }

    it('leaves as soon as the recorder is idle, without another refusal to prompt it', async () => {
      await setUp({ recorder: 'recording' });
      await router.navigateByUrl('/record');

      await refuseListProjects();
      expect(router.url).toBe('/record');

      // The take finished and was written to Dexie; only now is the screen free to change.
      recorderState.set('idle');
      TestBed.tick();

      await waitUntil(() => router.url === '/welcome', {
        describe: 'the deferred navigation',
        onTick: () => TestBed.tick(),
      });
    });

    /** The take survives, which is the entire reason the navigation waited. */
    it('leaves the recording that was in progress on disk', async () => {
      await setUp({ recorder: 'recording' });
      await router.navigateByUrl('/record');
      const store = TestBed.inject(EntryStore);

      await refuseListProjects();

      // The recorder goes on writing a chunk a second through the refusal, exactly as it does on a
      // phone: nothing about a dead credential stops a microphone.
      const entryId = crypto.randomUUID();
      const entry = await captureEntry(store, {
        entryId,
        chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
      });
      recorderState.set('idle');
      TestBed.tick();

      await waitUntil(() => router.url === '/welcome', {
        describe: 'the deferred navigation',
        onTick: () => TestBed.tick(),
      });

      expect(entry.id).toBe(entryId);
      expect(await store.getEntry(entryId)).not.toBeNull();
      const media = await db.media.where('entryId').equals(entryId).toArray();
      expect(media.length).toBeGreaterThan(0);
    });
  });

  // ---- Nothing local is ever lost -------------------------------------------------------------

  describe('the evidence on the phone', () => {
    /**
     * **PROJECT.md principle 3, pinned by row count.** Mutation-proven: add a single Dexie delete
     * to `SessionService.discard()` or to `report()` and this goes red.
     *
     * The phone is the source of truth until the server confirms. A sign-out is about *who* the
     * phone is, never about *what it holds* — so a finished entry, its assembled audio, its
     * photographs, its outbox row, a half-written capture's chunks and a confirmation draft are
     * all exactly as they were, and they resume on re-activation through
     * `EntryStore.releaseBlockedByAuth`.
     */
    it('deletes nothing at all — not an entry, an outbox row, a chunk or a draft', async () => {
      await setUp();
      await router.navigateByUrl('/');
      const store = TestBed.inject(EntryStore);

      // A finished, queued day: entry, assembled audio, one photograph, one outbox row.
      const sent = await captureEntry(store, { photoCount: 1 });
      await store.queue(sent.id);
      await store.saveConfirmDraft(sent.id, { notes: 'Postavljeni radijatori' } as never);

      // …and a capture the phone was interrupted in the middle of, which is what leaves loose
      // chunks on disk.
      const openId = crypto.randomUUID();
      await store.beginCapture({
        entryId: openId,
        project: { id: 'project-1', name: 'Vojvode Stepe 212', address: 'Vojvode Stepe 212' },
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/ogg;codecs=opus',
      });
      await store.appendChunk(openId, new Blob([new Uint8Array([7, 7])]));
      await store.appendChunk(openId, new Blob([new Uint8Array([8, 8])]));

      const before = await counts();
      expect(before.entries).toBeGreaterThan(0);
      expect(before.media).toBeGreaterThan(0);
      expect(before.outbox).toBeGreaterThan(0);
      expect(before.chunks).toBeGreaterThan(0);
      expect(before.confirmDrafts).toBeGreaterThan(0);

      await refuseListProjects();
      await waitUntil(() => router.url === '/welcome', {
        describe: 'the navigation to /welcome',
        onTick: () => TestBed.tick(),
      });

      expect(await counts()).toEqual(before);
      // And the bytes, not only the count: an audio row emptied in place would keep every number
      // above identical while losing the day.
      const audio = await db.media.where('[entryId+kind]').equals([sent.id, 'audio']).first();
      expect(audio?.blob?.size).toBeGreaterThan(0);
    });

    interface Counts {
      entries: number;
      media: number;
      outbox: number;
      chunks: number;
      captures: number;
      confirmDrafts: number;
    }

    async function counts(): Promise<Counts> {
      return {
        entries: await db.entries.count(),
        media: await db.media.count(),
        outbox: await db.outbox.count(),
        chunks: await db.chunks.count(),
        captures: await db.captures.count(),
        confirmDrafts: await db.confirmDrafts.count(),
      };
    }

    /**
     * The same guarantee, structurally.
     *
     * The row-count spec above proves the code as written deletes nothing; this proves the two
     * files *cannot* — there is no store, no database token and no Dexie handle in either of them,
     * so no future edit can quietly add a delete without first adding an import that fails here.
     * It is the shape `/company` uses to keep two men's activation codes out of one list, and it
     * is load-bearing for the same reason: a guarantee that lives only in a comment is a guarantee
     * until somebody is in a hurry.
     */
    it('cannot reach the store from either file, whatever anybody adds later', () => {
      const forbidden = ['EntryStore', 'TEREN_DB', 'TerenDb', 'Dexie', 'liveQuery', 'this.db'];
      for (const file of ['session.service.ts', 'device-refusal.service.ts', 'device-refusal.ts']) {
        const source = readFileSync(join(process.cwd(), 'src', 'app', 'core', 'session', file), 'utf8')
          // Comments first: all three files *discuss* Dexie at length, and a guard that fails on
          // prose about itself is a guard somebody deletes.
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\n]*/g, ' ');
        for (const word of forbidden) {
          expect(source, `${file} must not be able to reach the store (${word})`).not.toContain(
            word,
          );
        }
      }
    });
  });

  // ---- What is left behind --------------------------------------------------------------------

  describe('the note for /welcome', () => {
    it('writes one, so the screen can explain itself', async () => {
      await setUp();
      await router.navigateByUrl('/');

      await refuseListProjects();

      expect(readDeviceRefusal()).not.toBeNull();
      // A timestamp, not a reason: the 401 behind it is deliberately reasonless (§7), and a note
      // that guessed between a revoked phone, a removed worker and a suspended company would be
      // the app inventing the oracle the server refuses to be.
      expect(new Date(readDeviceRefusal() ?? '').getTime()).not.toBeNaN();
      expect(localStorage.getItem(DEVICE_REFUSAL_STORAGE_KEY)).toBe(readDeviceRefusal());
    });

    it('is written before the screen can possibly be shown', async () => {
      await setUp();
      await router.navigateByUrl('/');

      const pending = api.listProjects().catch(() => undefined);
      http.expectOne(`${API}/api/projects`).flush(null, { status: 401, statusText: 'Unauthorized' });
      await pending;

      // The note exists on the same turn as the sign-out, before the navigation has resolved —
      // otherwise `/welcome` renders its ordinary first-run self and the sentence never appears.
      expect(readDeviceRefusal()).not.toBeNull();
      expect(sessions.session()).toBeNull();
    });
  });

  // ---- The log --------------------------------------------------------------------------------

  describe('the action log', () => {
    /**
     * The one line that answers "why did this phone stop".
     *
     * Recorded **before** the credential is discarded, and that order is not cosmetic:
     * `ActionLogService` files an event under the credential it was captured with and asks
     * `SessionService.activated()` which one that is. A line later there would be no surface, and
     * the event would be dropped inside the logger — the log missing exactly the fact it exists
     * to carry.
     */
    it('records the sign-out under the credential it happened to', async () => {
      await setUp();
      await router.navigateByUrl('/');

      await refuseListProjects();

      expect(recorded).toHaveLength(1);
      expect(recorded[0].action).toBe(ACTIONS.sessionDeviceRefused);
      expect(recorded[0].sessionStillStored).toBe(true);
      expect(recorded[0].facts).toMatchObject({
        outcome: 'blocked',
        detail: { recording: false },
      });
    });

    it('says whether he was mid-sentence when it happened', async () => {
      await setUp({ recorder: 'recording' });
      await router.navigateByUrl('/record');

      await refuseListProjects();

      expect(recorded[0].facts).toMatchObject({ detail: { recording: true } });
    });
  });
});
