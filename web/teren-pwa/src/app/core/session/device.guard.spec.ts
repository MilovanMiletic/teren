import { TestBed } from '@angular/core/testing';
import { CanMatchFn, Route, Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { routes } from '../../app.routes';
import { ARCHIVE_ENTRY_PARAM } from '../archive/archive-route';
import { ArchivePage } from '../../features/archive/archive-page';
import { ActivatePage } from '../../features/auth/activate-page';
import { LoginPage } from '../../features/auth/login-page';
import { WelcomePage } from '../../features/auth/welcome-page';
import { HomePage } from '../../features/home/home-page';
import { PendingPage } from '../../features/pending/pending-page';
import { ProfilePage } from '../../features/profile/profile-page';
import { guardedRoutes } from '../../testing/route-harness';
import { routeUrlFor } from '../../testing/route-table';
import { CompanyPage } from '../../features/company/company-page';
import { WorkerPage } from '../../features/company/worker-page';
import { requiresCompanyAdmin, requiresDevice, requiresNoDevice } from './device.guard';
import { RETURN_URL_PARAM } from './return-url';
import { SESSION_STORAGE_KEY, Session } from './session';

const SESSION: Session = {
  token: 'trn_d_a-real-device-token',
  deviceId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  username: 'zoran.jovanovic',
  displayName: 'Zoran Jovanović',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Gradnja d.o.o.',
  activatedAt: '2026-08-30T08:00:00.000Z',
};

/** The entry a foreman's boss sent him a link to. */
const ENTRY_ID = '8f0d3a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f';

/**
 * The gate, exercised through the **real** route table.
 *
 * Paths, order and guards all come from `app.routes.ts` (`testing/route-harness.ts` only swaps
 * the lazy components for an empty one), so a rename, a missing guard or an auth route pushed
 * below the wildcard fails here rather than in a comment. Nothing in this file writes a path as a
 * string literal; every one is resolved from the screen it renders.
 */
describe('the device gate', () => {
  let router: Router;
  let harness: RouterTestingHarness;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let xhrSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Every path this file needs, resolved from the route table once, before anything is stubbed.
   *
   * `routeUrlFor` resolves a `loadComponent`, which is a dynamic `import()`, and the network spies
   * below are deliberately hostile — they throw. Resolving here keeps the two apart: the imports
   * are done and cached before a test ever installs a spy, so what those spies see is the gate
   * and nothing else. (It also stops the suite from hanging, which is how this was found.)
   */
  let home: string;
  let welcome: string;
  let login: string;
  let activate: string;
  let diary: string;
  let pending: string;
  let profile: string;
  let company: string;
  let worker: string;
  let deepLink: string;

  beforeAll(async () => {
    home = await routeUrlFor(HomePage);
    welcome = await routeUrlFor(WelcomePage);
    login = await routeUrlFor(LoginPage);
    activate = await routeUrlFor(ActivatePage);
    diary = await routeUrlFor(ArchivePage);
    pending = await routeUrlFor(PendingPage);
    profile = await routeUrlFor(ProfilePage);
    company = await routeUrlFor(CompanyPage);
    worker = await routeUrlFor(WorkerPage);
    deepLink = `${diary}?${ARCHIVE_ENTRY_PARAM}=${ENTRY_ID}`;
  });

  async function boot(session: Session | null): Promise<void> {
    localStorage.clear();
    if (session) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter(guardedRoutes())] });
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create();
  }

  /** Follow a URL the way an address bar does, and report where the app actually ended up. */
  async function follow(url: string): Promise<string> {
    await harness.navigateByUrl(url);
    return router.url;
  }

  function nextOf(url: string): string | null {
    return router.parseUrl(url).queryParams[RETURN_URL_PARAM] ?? null;
  }

  beforeEach(() => {
    // Nothing in the gate may reach the network. Both spies are assertions, not stubs: they throw
    // rather than answer, so an implementation that starts asking `/api/me` whether the
    // credential is still good fails here instead of merely being slower.
    fetchSpy = vi.fn(() => {
      throw new Error('the gate made a network call');
    });
    vi.stubGlobal('fetch', fetchSpy);
    xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {
      throw new Error('the gate made a network call');
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    xhrSpy.mockRestore();
    localStorage.clear();
  });

  describe('a phone nobody has activated', () => {
    beforeEach(async () => {
      await boot(null);
    });

    it('is sent to Welcome from the record button, having asked the network nothing', async () => {
      // Home, the first frame of a cold start — the case invariant 1 is about.
      expect(await follow(home)).toBe(welcome);
      // No `?next=`: Home is where the fallback goes anyway, and the parameter would be noise.
      expect(nextOf(router.url)).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrSpy).not.toHaveBeenCalled();
    });

    /**
     * The deep link that proves the parameter is read from the URL and not from the segments.
     *
     * `CanMatchFn` is handed path segments alone, with no query string. The archive opens one
     * record as `?entry=<id>`, so a `next` built from segments would drop exactly the part that
     * says *which* record — and a foreman following his boss's link would arrive at a list.
     */
    it('remembers the whole attempted URL, query string included', async () => {
      const landed = await follow(deepLink);

      expect(landed.startsWith(welcome)).toBe(true);
      expect(nextOf(landed)).toBe(deepLink);
    });

    it('guards the wildcard redirect target, so a mistyped URL does not slip through', async () => {
      // `'**' → redirectTo: ''` re-runs matching. Without a guard on `''` the redirect would be
      // the way past the gate: type any nonsense and land on Home.
      const landed = await follow('/nonsense');

      expect(landed.startsWith(welcome)).toBe(true);
    });

    /**
     * The profile is a screen *inside* the app, not a door into it (F5).
     *
     * A phone nobody has activated has no profile to read — `/api/me` would answer for whatever
     * credential happened to be baked into the build — so it belongs behind the gate with the
     * record button and the archive.
     */
    it('is sent to Welcome from the profile, carrying it as the destination', async () => {
      const landed = await follow(profile);

      expect(landed.startsWith(welcome)).toBe(true);
      expect(nextOf(landed)).toBe(profile);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('lets him reach Welcome and the code screen, which are the only way forward', async () => {
      expect(await follow(welcome)).toBe(welcome);
      expect(await follow(activate)).toBe(activate);
      expect(await follow(login)).toBe(login);
    });
  });

  describe('a phone that belongs to a worker', () => {
    beforeEach(async () => {
      await boot(SESSION);
    });

    it('opens straight onto the record button, with no network call in the way', async () => {
      expect(await follow(home)).toBe(home);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrSpy).not.toHaveBeenCalled();
    });

    it('is never shown a sign-in screen it has no sign-in for', async () => {
      // A stray link: a bookmark from the day he joined, or a URL passed round in a group chat.
      expect(await follow(welcome)).toBe(home);
      expect(await follow(login)).toBe(home);
    });

    /**
     * The revoked phone's door.
     *
     * A revoked device keeps its session — revocation is deliberately not a gate — so the man who
     * most needs the code screen is holding a phone that still looks activated. `requiresNoDevice`
     * on this route would lock him out of the only screen that can let him back in.
     */
    it('can still reach the code screen, which is how a revoked phone comes back', async () => {
      expect(await follow(activate)).toBe(activate);
    });

    it('opens his own account, because the gate is about a credential and not about a role', async () => {
      expect(await follow(profile)).toBe(profile);
    });

    it('follows a deep link straight through', async () => {
      expect(await follow(deepLink)).toBe(deepLink);
    });

    it('finishes an interrupted journey rather than dumping him on Home', async () => {
      // He was sent to Welcome holding a destination, and activated in another tab — or simply
      // came back to the link later. The parameter is still good; honour it.
      expect(await follow(`${welcome}?${RETURN_URL_PARAM}=${encodeURIComponent(pending)}`)).toBe(
        pending,
      );
    });

    it('will not be redirected off this origin by a poisoned return URL', async () => {
      for (const hostile of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
        expect(
          await follow(`${welcome}?${RETURN_URL_PARAM}=${encodeURIComponent(hostile)}`),
          hostile,
        ).toBe(home);
      }
    });
  });

  /**
   * The shape of the answer, not just its value.
   *
   * `SessionService` reads the credential from `localStorage` during construction precisely so
   * this guard can be a pure boolean over one signal read: no awaited promise, no observable, no
   * frame in which the app does not know who it is. Make either guard `async`, or have it return
   * an `Observable`, and this fails — which is the point. A foreman in a basement must not meet a
   * spinner where the record button belongs.
   */
  describe('answers synchronously', () => {
    const anyRoute: Route = { path: '' };
    // Angular 22 hands `canMatch` a partial route snapshot as well. Neither guard reads it — the
    // attempted URL comes from `getCurrentNavigation()`, because the snapshot's `url` is this
    // route's segments and `next` has to be the whole journey — so an empty stand-in is honest.
    const noSnapshot = {} as Parameters<CanMatchFn>[2];

    it('returns a plain decision, never something to wait on', async () => {
      await boot(SESSION);

      for (const guard of [requiresDevice, requiresNoDevice]) {
        const answer = TestBed.runInInjectionContext(() => guard(anyRoute, [], noSnapshot)) as {
          then?: unknown;
          subscribe?: unknown;
        };

        expect(typeof answer?.then).not.toBe('function');
        expect(typeof answer?.subscribe).not.toBe('function');
      }
    });

    it('says yes to a home route for an activated phone and no to one without a session', async () => {
      await boot(SESSION);
      expect(TestBed.runInInjectionContext(() => requiresDevice(anyRoute, [], noSnapshot))).toBe(
        true,
      );

      await boot(null);
      // Not `true`: a `UrlTree` to Welcome. The value matters less than that it is decided here
      // and now, with nothing awaited.
      expect(
        TestBed.runInInjectionContext(() => requiresDevice(anyRoute, [], noSnapshot)),
      ).not.toBe(true);
      expect(TestBed.runInInjectionContext(() => requiresNoDevice(anyRoute, [], noSnapshot))).toBe(
        true,
      );
    });
  });

  /**
   * The trap under the empty path, asserted directly because its symptom is a hang.
   *
   * Angular runs a route's `canMatch` guards while *matching* it, before it discovers that a leaf
   * route with an empty path has left segments unconsumed. So a bare `path: ''` runs its guard on
   * the way to every URL in the app — and this guard answers an un-activated phone with a
   * redirect to `/welcome`, which restarts matching, which runs it again. The app hangs on a blank
   * screen with nothing in the console.
   *
   * **This assertion is not the red line, and the comment that said so was measured and found
   * wrong.** Remove `pathMatch` and run this file alone: the redirect loop recurses through
   * microtasks, which blocks the event loop, so vitest's timer-based timeout never fires — the
   * navigation specs above hang, and because they hang *before* this one in file order, this
   * assertion never runs at all. The file was killed from outside at 240 s having printed nothing.
   * The protection degrades into exactly the lost afternoon it claims to prevent.
   *
   * The red line lives in `app.routes.spec.ts`, which asserts the same property in a router-free
   * file that cannot hang, in its own worker. This copy stays because it is the assertion nearest
   * the guard it protects, and because the two together are what makes the hang legible: one
   * worker stops, another prints the reason.
   */
  it('matches Home on the full URL, or the gate becomes an infinite redirect', () => {
    const homeRoute = routes.find((route) => `/${route.path}` === home);

    expect(homeRoute?.pathMatch).toBe('full');
  });

  /**
   * A guard is only as good as the table it is attached to.
   *
   * Derived from the real routes: every screen that is not an auth screen must be gated, Welcome
   * and Login must refuse an activated phone, and `/activate` must carry no guard at all. Add a
   * route and forget to say which side of the gate it is on, and this fails.
   */
  it('is attached to every route that is not an auth screen', () => {
    for (const route of routes) {
      const url = `/${route.path}`;
      if (route.path === '**') {
        // The redirect target is guarded instead; the wildcard itself may not be, or a mistyped
        // URL would be refused rather than redirected.
        expect(route.canMatch ?? []).toEqual([]);
      } else if (url === activate) {
        expect(route.canMatch ?? []).toEqual([]);
      } else if (url === welcome || url === login) {
        expect(route.canMatch, url).toEqual([requiresNoDevice]);
      } else if (url === company || url === worker) {
        // The two screens gated on an *admin* credential rather than on this phone's device
        // session. A company admin signs in with a password and never holds a device token, so
        // `requiresDevice` here would answer a valid sign-in by demanding an activation code he
        // cannot have. Named explicitly rather than folded into the branch below, so that adding
        // an admin screen is a decision someone has to write down here — which is exactly what
        // happened when one man's page (`/company/worker/:workerId`) joined the table on
        // 2026-09-01 and this spec went red until it was said out loud.
        expect(route.canMatch, url).toEqual([requiresCompanyAdmin]);
      } else {
        expect(route.canMatch, url).toEqual([requiresDevice]);
      }
    }

    // Home is `''`, so `routeUrlFor` returns `/` — a guard on that is what the first block above
    // proves. Named here so a reader can see the empty path was not overlooked.
    expect(home).toBe('/');
  });
});
