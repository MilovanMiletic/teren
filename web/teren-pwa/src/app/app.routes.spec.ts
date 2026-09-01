import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { routes } from './app.routes';
import { ARCHIVE_ENTRY_PARAM } from './core/archive/archive-route';
import { RETURN_URL_PARAM } from './core/session/return-url';

/**
 * Line comments removed, without eating code that merely contains `//`.
 *
 * A blunt "slash-slash to end of line" regex looks right and is not: it cuts the line at a `//`
 * that is inside a string, so
 * `const help = 'https://teren.rs'; this.router.navigate(['/typo'])` — one line, two statements —
 * is invisible to every scan below. The whole point of these guards is that a call site cannot
 * hide, so the stripper tracks quotes and only treats `//` as a comment when it is outside one.
 *
 * Nothing is *removed* here except comments: an unbalanced quote (an apostrophe in prose that
 * survived the block-comment pass) can only cause a comment to be kept, never a call site to be
 * dropped. The failure direction stays safe — a false positive that someone reads, never a false
 * negative that nobody sees.
 */
function stripLineComments(text: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }

    if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) {
        break;
      }
      out += '\n';
      i = end;
      continue;
    }

    out += char;
  }

  return out;
}

/**
 * Every source file of the app, read off disk, comments removed.
 *
 * The same idiom `i18n.spec.ts` uses, and for the same reason: the suite runs on jsdom under
 * Node, so it can read the files that actually ship. Comments go first because the route table
 * and `rescue.service.ts` both *discuss* paths in prose, and a guard that fails on prose is a
 * guard people delete.
 */
function sourceFiles(dir = join(process.cwd(), 'src', 'app')): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      return sourceFiles(path);
    }
    if (item.name.endsWith('.spec.ts') || !/\.(ts|html)$/.test(item.name)) {
      return [];
    }
    const withoutBlocks = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    return [{ path, text: stripLineComments(withoutBlocks) }];
  });
}

/** A navigation the app performs, as written at the call site. */
interface NavigationTarget {
  /** `['/entry', entry.id]` → `/entry` + one more segment. */
  readonly source: string;
  readonly path: string;
  readonly extraSegments: number;
  readonly file: string;
}

/** The first element of a `navigate([...])`, once we know whether it can be resolved. */
type FirstElement = { readonly path: string } | 'unresolvable' | 'not-a-string';

/**
 * `'/diary'` → a path. `` `/entry/${id}` `` and `'record'` → unresolvable, and *reported*. A bare
 * identifier → not a string at all, and skipped: that is the documented limitation below.
 */
function firstElement(raw: string): FirstElement {
  if (!/^['"`]/.test(raw)) {
    return 'not-a-string';
  }
  const literal = /^(['"`])(\/[^'"`]*)\1$/.exec(raw);
  if (!literal || literal[2].includes('${')) {
    return 'unresolvable';
  }
  return { path: literal[2] };
}

/**
 * Every absolute `router.navigate([...])` in the app, and every one that cannot be read.
 *
 * Quoted or backticked literals are resolved; a template literal with `${}` in it, or a relative
 * path, is returned as `unresolvable` so the spec can fail loudly rather than pass in silence —
 * that is the difference between a guard and a comment. A first element that is not a string at
 * all (a variable, a computed array) is skipped; that remains a deliberate limitation, and the
 * failure direction is safe (a missed call site, never an invented one).
 */
function navigationTargets(): { targets: NavigationTarget[]; unresolvable: string[] } {
  const targets: NavigationTarget[] = [];
  const unresolvable: string[] = [];

  for (const { path: file, text } of sourceFiles()) {
    for (const match of text.matchAll(/\.navigate\(\s*\[([^\]]*)\]/g)) {
      const elements = match[1]
        .split(',')
        .map((element) => element.trim())
        .filter((element) => element.length > 0);
      const source = `[${elements.join(', ')}]`;
      const first = firstElement(elements[0] ?? '');

      if (first === 'not-a-string') {
        continue;
      }
      if (first === 'unresolvable') {
        unresolvable.push(`${source} in ${file}`);
        continue;
      }

      targets.push({
        source,
        path: first.path,
        extraSegments: elements.length - 1,
        file,
      });
    }
  }

  return { targets, unresolvable };
}

/**
 * The number of navigations the app performs today.
 *
 * A floor of "some" is not a floor: at 15 against an actual 26, eleven call sites could vanish
 * before the guard noticed, and the dangerous unit is *one* — the single navigation whose path was
 * renamed. So this is pinned exactly, and bumped deliberately when a screen gains or loses a
 * navigation. A failure here is never a bug on its own; it is the extractor telling you it now
 * sees a different app than the one this spec was written against, which is exactly when you want
 * to look.
 *
 * **29 → 32 at F6**: the login screen now sends a company admin to `/company`, `ui/company-link.ts`
 * offers the same door from the app header and the foot of Home, and `/company` itself has a sign-out
 * that lands on `/login`. Each was counted off the tree, not assumed.
 *
 * **26 → 29 at F5**, and **29 again on 2026-08-31** — the founder's move of the profile control
 * out of Home's centre column and into the shared chrome took one navigation off `home-page.ts`
 * and put one on `ui/profile-link.ts`. The number is unchanged and the app is not: re-counted off
 * the tree rather than assumed, because a coincidence that leaves an assertion green is exactly
 * the kind of thing this pin exists to make somebody look at.
 *
 * **32 → 34 at F8**: the revocation surface. Home's notice and the pending row's "Unesi novi kod"
 * both send him to `/activate` carrying where he was, which is two navigations to a route that
 * already existed. Counted off the tree.
 *
 * **34 → 36 with the office rework (2026-09-01)**: the people list opens one man's page, and that
 * page has the way back to the people. Counted off the tree.
 *
 * **36 → 38 at F7**: the platform's people list opens the customers page, and `/set-password`
 * sends a man who has just chosen a passphrase on to `/login`. Counted off the tree.
 *
 * **38 → 40**: the people list opens one account's page, and that page has the way back to the
 * people. Counted off the tree.
 *
 * **40 → 41**: `platform-link.ts`, the chrome control that opens `/platform`.
 *
 * Worth recording what this count could not catch, since it was green throughout. All forty
 * navigations resolved, `/platform` among them — but its *only* navigation was the one
 * `login-page.ts` performs on a successful sign-in, and on the founder's own browser `/login` was
 * itself unreachable (`requiresNoAdminSession`). A route table cannot see that: reachability is a
 * property of the guards, not of the paths. `device.guard.spec.ts` pins it where it lives.
 */
const NAVIGATION_COUNT = 41;

/**
 * The query parameters a navigation may put on the URL, by the name of the constant that holds
 * them.
 *
 * A query parameter is the one part of a URL the route table cannot see, so no guard derived from
 * `app.routes.ts` can catch a producer and a consumer drifting apart on `?entry=`. The rule that
 * replaces it: **a navigation may not spell a query parameter out as a literal.** Both sides
 * import one constant, the compiler resolves it, and the two cannot disagree. Adding a third
 * parameter means adding its constant here, on purpose.
 *
 * **4 → 5 at F6**: `requiresCompanyAdmin` sends a caller who is not signed in to `/login` carrying
 * where he was going, exactly as `requiresDevice` sends an un-activated phone to `/welcome`.
 *
 * **5 → 7 at F8**: Home's revocation notice and the pending row's "Unesi novi kod" each carry
 * `RETURN_URL_PARAM` to `/activate`, so the code screen is a detour rather than a destination.
 */
const QUERY_PARAM_CONSTANTS = ['ARCHIVE_ENTRY_PARAM', 'RETURN_URL_PARAM'];

/** How many `queryParams: { … }` literals the app writes today. Pinned for the same reason. */
const QUERY_PARAM_USE_COUNT = 8;

/** Every `queryParams: { … }` object literal written at a navigation call site. */
function queryParamKeys(): { key: string; source: string; file: string }[] {
  const uses: { key: string; source: string; file: string }[] = [];
  for (const { path: file, text } of sourceFiles()) {
    for (const match of text.matchAll(/queryParams:\s*\{([^}]*)\}/g)) {
      const body = match[1].trim();
      if (body.length === 0) {
        continue;
      }
      for (const property of body.split(',')) {
        const key = property.split(':')[0].trim();
        if (key.length > 0) {
          uses.push({ key, source: `queryParams: { ${body} }`, file });
        }
      }
    }
  }
  return uses;
}

/** `/entry` plus one more element → `['entry', '<param>']`. `/` alone → `[]`. */
function segmentsOf(target: NavigationTarget): string[] {
  const literal = target.path.split('/').filter((segment) => segment.length > 0);
  return [...literal, ...Array<string>(target.extraSegments).fill(' param')];
}

/** Does this registered route accept exactly these segments? Parameters match anything. */
function accepts(routePath: string, segments: string[]): boolean {
  const routeSegments = routePath.split('/').filter((segment) => segment.length > 0);
  if (routeSegments.length !== segments.length) {
    return false;
  }
  return routeSegments.every(
    (segment, index) => segment.startsWith(':') || segment === segments[index],
  );
}

describe('app routes', () => {
  /**
   * The guard the app did not have, and the reason F4b existed at all.
   *
   * After the F4 back-out, `capture-recording-page.ts` navigated to `/entry/<id>` while the table
   * still registered `unos/:entryId`. Angular does not complain about that — `'**' → redirectTo:
   * ''` quietly re-runs matching and the foreman lands on Home, mid-flow, with nothing on screen
   * to say what happened. `ng build` was clean and all 538 specs passed, because every spec on
   * both sides of the coupling restated the path instead of resolving it.
   *
   * This reads the navigation targets out of the shipped source and resolves each one against the
   * shipped table. A renamed route, a typo, or a wrong number of segments fails here — for every
   * screen at once, without each screen's spec having to remember to care.
   */
  it('registers a route for every navigation the app performs', () => {
    const { targets, unresolvable } = navigationTargets();

    expect(
      unresolvable,
      "these navigations cannot be resolved against the route table — write the path as a literal array (`navigate(['/entry', id])`) so this guard can see it",
    ).toEqual([]);

    // If the extraction itself ever silently stops finding call sites, this guard becomes a spec
    // that asserts nothing while still passing. Pin the count, not a floor under it.
    expect(
      targets.length,
      'the navigation count changed — bump NAVIGATION_COUNT once you have checked why',
    ).toBe(NAVIGATION_COUNT);

    const paths = routes.map((route) => route.path).filter((path) => path !== '**');
    const unmatched = targets.filter(
      (target) => !paths.some((path) => accepts(path!, segmentsOf(target))),
    );

    expect(
      unmatched.map((target) => `${target.source} in ${target.file}`),
      'these navigations fall through to the wildcard and land the user on Home',
    ).toEqual([]);
  });

  /**
   * The half of a URL the route table cannot see.
   *
   * `?entry=<id>` is a contract between three producers (Home, the confirmation gate, the archive
   * itself) and one consumer (`archive-page.ts`), with no compiler in between and no route to
   * derive it from. It was renamed from `?unos=` in F4b along with the six paths, and it was the
   * one row of that table nothing pinned: flipping a producer back to `unos` left the whole suite
   * green while a foreman who had just confirmed his day landed on the diary *list* with his
   * record unopened.
   *
   * So every key here must be a computed `[CONSTANT]` naming one of the shared parameter names —
   * which the compiler then resolves for producer and consumer alike. A literal key fails, even
   * when it is spelled correctly today.
   */
  it('names every query parameter it navigates with, instead of spelling it out', () => {
    const uses = queryParamKeys();

    // Same reasoning as the navigation count: an extractor that finds nothing must not pass.
    expect(
      uses.length,
      'the queryParams count changed — bump QUERY_PARAM_USE_COUNT once you have checked why',
    ).toBe(QUERY_PARAM_USE_COUNT);

    const literals = uses.filter((use) => !/^\[[A-Za-z_$][\w$]*\]$/.test(use.key));
    expect(
      literals.map((use) => `${use.key} in ${use.source} (${use.file})`),
      'a query parameter written as a literal cannot be kept in step with the code that reads it — import the constant and use a computed key: `{ [ARCHIVE_ENTRY_PARAM]: id }`',
    ).toEqual([]);

    const unknown = uses.filter((use) => !QUERY_PARAM_CONSTANTS.includes(use.key.slice(1, -1)));
    expect(
      unknown.map((use) => `${use.key} in ${use.file}`),
      'a query parameter constant that is not in QUERY_PARAM_CONSTANTS — add it there deliberately',
    ).toEqual([]);

    // And the constants really are the two names this app navigates with, so a rename of either
    // one lands here rather than nowhere.
    expect([ARCHIVE_ENTRY_PARAM, RETURN_URL_PARAM]).toEqual(['entry', 'next']);
  });

  it('routes home, capture, saved, confirm, archive, pending, profile, identity and the office, and sends anything else home', () => {
    // English throughout since F4b (founder, 2026-08-30) — routes and query parameters are
    // identifiers. Nothing the foreman reads changed: the UI is still Transloco, still Serbian by
    // default.
    expect(routes.map((route) => route.path)).toEqual([
      '',
      'record',
      'entry/:entryId',
      // The confirmation gate is a path segment, not a query parameter: it is a single-entry
      // screen with a form in it, so back means "leave this entry" and a reload returns to it.
      'confirm/:entryId',
      // One archive route, not two: the open record is `?entry=<id>`, so the desktop list rail
      // survives a click instead of being torn down and rebuilt.
      'diary',
      'pending',
      // His own account (F5) — gated like the screens above it, not an auth screen.
      'profile',
      'welcome',
      'activate',
      'login',
      // The office (F6). Gated on an *admin* credential rather than on this phone's device
      // session — the only routes in the table that are, and the reason they are listed last among
      // the real routes rather than beside `profile`.
      'company',
      // One foreman: his code, his phones, the revoke. A route rather than a card that opens
      // inside the list, which is what makes "never two men's codes on one screen" structural.
      'company/worker/:workerId',
      // Where an invite link lands (F7). Unguarded like `activate`: the man opening it has no
      // credential at all, which is the entire point of the link.
      'set-password',
      // Teren's own surface (F7). Gated on `requiresSuperAdmin` — a third admin credential, and
      // deliberately not "company admin or better": the roles are not a hierarchy, and a gate
      // written as a rank is the first step towards staff reading a customer's diary.
      'platform',
      // The customers, on a route of their own so the heaviest action in the product does not
      // sit beside a row about somebody's phone.
      'platform/companies',
      // One account: his link, and the switch that takes him out of service. A route rather than
      // a row action, because re-inviting mints a working credential and supersedes any live one.
      'platform/user/:userId',
      '**',
    ]);
    expect(routes.at(-1)?.redirectTo).toBe('');
  });

  /**
   * The trap under the empty path, asserted where a failure can still print.
   *
   * Angular runs a route's `canMatch` guards while *matching* it, before it discovers that a leaf
   * route with an empty path has left segments unconsumed. So a bare `path: ''` runs its guard on
   * the way to every URL in the app — and `requiresDevice` answers an un-activated phone with a
   * redirect to `/welcome`, which restarts matching, which runs it again.
   *
   * `device.guard.spec.ts` asserts this too, and calls itself the red line. It is not, quite: the
   * redirect loop it guards against blocks the event loop with microtask recursion, so vitest's
   * timer-based timeout never fires and that whole *file* hangs until something outside kills it —
   * including the direct assertion, which sits after the navigation specs in file order and never
   * runs. Removing `pathMatch` and running that file alone was measured: no output, no red line,
   * killed at 240 s.
   *
   * This copy is the one that prints. It is a router-free file — nothing here navigates, so
   * nothing here can hang — and it runs in its own worker, so the founder gets a named failure
   * next to the hang instead of only the hang.
   */
  it('matches Home on the full URL, or the gate becomes an infinite redirect', () => {
    const home = routes.find((route) => route.path === '');

    expect(home, 'no route registers the empty path').toBeDefined();
    expect(
      home?.pathMatch,
      'a gated empty-path route without `pathMatch: full` runs its guard on every URL in the app and redirects to itself',
    ).toBe('full');
  });

  /**
   * The ordering mistake that would cost nothing at compile time and everything at runtime.
   *
   * `'**' → redirectTo: ''` re-runs matching, so any route declared after the wildcard is
   * unreachable — the address bar would show `/activate` and Home would render, which is also
   * precisely the state `rescue.service.ts` reads `location.pathname` to understand. Asserted as
   * a property of the list rather than as a position, so it keeps holding as routes are added.
   */
  it('registers every real route before the wildcard', () => {
    const wildcard = routes.findIndex((route) => route.path === '**');
    expect(wildcard).toBe(routes.length - 1);
  });
});
