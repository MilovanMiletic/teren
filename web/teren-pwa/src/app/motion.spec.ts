import { readFileSync, readdirSync } from 'node:fs';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, RouterOutlet, provideRouter, withViewTransitions } from '@angular/router';
import { join, relative, sep } from 'node:path';

/**
 * The motion system, guarded at the source.
 *
 * ## Why a scan
 *
 * `ng test` runs on jsdom, and **jsdom lays nothing out and animates nothing**. Not one assertion
 * in this suite can see whether a card faded, how long it took, or whether a reader who asked the
 * operating system for stillness got it. That is the same blind spot the geometry of
 * `ui/menu-placement.ts` was pulled into a pure function for, and the same one `action-wiring.spec.ts`
 * exists to cover: a feature that cannot detect its own absence needs a guard that reads the
 * shipped source and asks structural questions about it.
 *
 * Three of them, each answering something that has actually gone wrong in a codebase:
 *
 * - **Every duration and curve comes from a token.** `design/tokens.md` §Motion is binding the same
 *   way the colour table is, and before this pass four stylesheets had each written
 *   `transition: transform 120ms ease` by hand — the same value, four times, none of them findable
 *   from the others.
 * - **Reduced motion collapses everything.** One wildcard rule, no per-component exceptions. The
 *   danger is not that somebody deletes it; it is that somebody adds an animation *property* the
 *   rule does not name (a delay, a view transition) and the rule goes quietly incomplete.
 * - **No keyframe is dead, and none is defined twice.** Angular's emulated encapsulation rewrites
 *   selectors and leaves `@keyframes` names alone, so component stylesheets share one global
 *   namespace: two components writing the same name is one definition with two authors.
 */

/** Where the raw numbers are allowed to live, and the only place. */
const TOKENS: Record<string, string> = {
  '--motion-fast': '120ms',
  '--motion-base': '200ms',
  '--motion-slow': '300ms',
  '--motion-pulse': '1200ms',
  '--motion-meter': '90ms',
  '--ease-standard': 'cubic-bezier(0.2, 0, 0, 1)',
  '--ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
};

const SRC = join(process.cwd(), 'src');
const GLOBAL_STYLESHEET = join(SRC, 'styles.css');

/** Every stylesheet that ships, plus every component file (which may carry inline styles). */
function styleSources(dir = SRC): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      return item.name === 'node_modules' ? [] : styleSources(path);
    }
    if (item.name.endsWith('.spec.ts')) {
      return [];
    }
    if (!item.name.endsWith('.css') && !item.name.endsWith('.ts')) {
      return [];
    }
    return [{ path, text: withoutComments(readFileSync(path, 'utf8')) }];
  });
}

/**
 * Comments first, always — this file's own prose quotes `120ms` and so does the token table's, and
 * a guard that fails on a discussion of itself is a guard the next person deletes.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}

/** `app/features/home/home-page.css`, so a failure names the file the way a person would. */
function shortPath(path: string): string {
  return relative(SRC, path).split(sep).join('/');
}

/**
 * A block by its opening line, braces balanced.
 *
 * `indexOf('}')` is not good enough for a media query that contains rules: it would cut at the end
 * of the first one and leave the rest of the block in the text being scanned.
 */
function blockAfter(text: string, opener: string): string {
  const start = text.indexOf(opener);
  if (start === -1) {
    return '';
  }
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') {
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return text.slice(start);
}

const REDUCED_MOTION_OPENER = '@media (prefers-reduced-motion: reduce)';

/** Every `animation`/`transition` declaration in a file, as `property: value` pairs. */
function motionDeclarations(text: string): { property: string; value: string }[] {
  const found: { property: string; value: string }[] = [];
  const pattern =
    /\b(animation|transition)(-duration|-delay|-timing-function|-name)?\s*:\s*([^;{}]+)/g;
  for (const match of text.matchAll(pattern)) {
    found.push({ property: `${match[1]}${match[2] ?? ''}`, value: match[3].trim() });
  }
  return found;
}

describe('motion tokens', () => {
  const globalStylesheet = withoutComments(readFileSync(GLOBAL_STYLESHEET, 'utf8'));

  it('defines every duration and curve exactly once, with the documented value', () => {
    for (const [token, value] of Object.entries(TOKENS)) {
      const declarations = [
        ...globalStylesheet.matchAll(new RegExp(`${token}\\s*:\\s*([^;]+);`, 'g')),
      ];

      expect(
        declarations.length,
        `${token} is declared ${declarations.length} times in styles.css`,
      ).toBe(1);
      expect(declarations[0][1].trim(), `${token} does not match design/tokens.md §Motion`).toBe(
        value,
      );
    }
  });

  /**
   * The rule the whole system rests on: a component may **name** a duration, never write one.
   *
   * The exemption list is two entries long and both are structural rather than cosmetic — a
   * repeating pulse whose curve must be symmetric, and a real-time meter that must be linear. Both
   * still take their *duration* from a token; what they opt out of is `--ease-standard`.
   */
  it('lets no stylesheet write a duration of its own', () => {
    const offenders: string[] = [];

    for (const { path, text } of styleSources()) {
      // The reduced-motion rule is where 0.001ms is the point, so it is scanned separately below.
      const scanned = text.replace(blockAfter(text, REDUCED_MOTION_OPENER), ' ');

      for (const { property, value } of motionDeclarations(scanned)) {
        if (/(^|[\s(,])[\d.]+m?s\b/.test(value)) {
          offenders.push(`${shortPath(path)} — ${property}: ${value}`);
        }
        if (value.includes('cubic-bezier')) {
          offenders.push(
            `${shortPath(path)} — ${property}: ${value} (name --ease-standard instead)`,
          );
        }
      }
    }

    expect(offenders, 'raw durations or curves outside design/tokens.md §Motion').toEqual([]);
  });

  /** And the other half of the same rule: a duration that is a token is one of *these* tokens. */
  it('names only tokens that exist', () => {
    const unknown: string[] = [];

    for (const { path, text } of styleSources()) {
      for (const { value } of motionDeclarations(text)) {
        for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (match[1].startsWith('--motion') || match[1].startsWith('--ease')) {
            if (!(match[1] in TOKENS)) {
              unknown.push(`${shortPath(path)} — ${match[1]}`);
            }
          }
        }
      }
    }

    expect(
      unknown,
      'a motion token nothing defines resolves to nothing and the animation is instant',
    ).toEqual([]);
  });
});

describe('reduced motion', () => {
  const globalStylesheet = withoutComments(readFileSync(GLOBAL_STYLESHEET, 'utf8'));
  const rule = blockAfter(globalStylesheet, REDUCED_MOTION_OPENER);

  it('exists, and reaches every element in the app', () => {
    expect(rule, 'styles.css has no prefers-reduced-motion rule at all').not.toBe('');
    // The wildcard and both pseudo-elements: a decorative circle drawn in `::before` animates too.
    expect(rule).toContain('*,');
    expect(rule).toContain('*::before');
    expect(rule).toContain('*::after');
  });

  /**
   * **Every property, not only the two that were there.**
   *
   * The durations alone are not enough: a staggered enter with its delays intact still costs its
   * stagger — the element sits invisible and then snaps in, which is a slower screen than one that
   * never animated. This is the assertion that goes red when somebody introduces a property the
   * rule does not name.
   */
  it('collapses duration, delay and iteration, and wins over any component', () => {
    for (const property of [
      'animation-duration',
      'animation-delay',
      'animation-iteration-count',
      'transition-duration',
      'transition-delay',
    ]) {
      const declaration = new RegExp(`${property}\\s*:\\s*[^;]+!important`);
      expect(
        declaration.test(rule),
        `${property} is not collapsed, or is collapsed without !important`,
      ).toBe(true);
    }
  });

  /**
   * The router's snapshots are pseudo-elements on the document, not elements, so the wildcard
   * cannot reach them — the one animation in the app that needs naming twice.
   */
  it('collapses the route cross-fade as well as the elements', () => {
    expect(rule).toContain('::view-transition-old(root)');
    expect(rule).toContain('::view-transition-new(root)');
  });
});

describe('keyframes', () => {
  const sources = styleSources();

  /** Every `@keyframes` the app defines, and the files that define it. */
  const defined = new Map<string, string[]>();
  for (const { path, text } of sources) {
    for (const match of text.matchAll(/@keyframes\s+([\w-]+)/g)) {
      defined.set(match[1], [...(defined.get(match[1]) ?? []), shortPath(path)]);
    }
  }

  it('defines each name once, because the namespace is global', () => {
    const duplicated = [...defined.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(', ')}`);

    expect(
      duplicated,
      'Angular does not scope @keyframes names; two definitions is a race',
    ).toEqual([]);
  });

  /**
   * The lesson from F12's action vocabulary, applied to a second registry: **walk it, and ask
   * whether each entry can ever happen.** Thirty-three slugs shipped and twenty-six of them had
   * nothing that could emit them, and every spec passed, because each asked whether what *is*
   * wired is wired correctly. A keyframe nothing names is the same defect in CSS.
   */
  it('has nothing dead in it', () => {
    const named = new Set<string>();
    for (const { text } of sources) {
      for (const { property, value } of motionDeclarations(text)) {
        if (property === 'animation' || property === 'animation-name') {
          for (const word of value.split(/[\s,]+/)) {
            named.add(word);
          }
        }
      }
    }

    const dead = [...defined.keys()].filter((name) => !named.has(name));

    expect(dead, 'a keyframe no animation names is dead code that reads as a feature').toEqual([]);
  });
});

/**
 * The exits, which are the one piece of this pass a consumer has to opt into.
 *
 * `ui/modal-sheet.ts` is rendered by an `@if` in the screen that owns it, so the node Angular
 * removes is the host element in the **parent's** template — and an `animate.leave` *host* binding
 * compiles to nothing in Angular 22.1 (measured against the shipped bundle). So the binding is
 * written at each call site, and forgetting it is invisible: the dialog still closes correctly, it
 * simply stops fading. Nothing would go red. Hence this.
 */
describe('overlay exits', () => {
  function templates(dir = join(SRC, 'app')): { path: string; text: string }[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        return templates(path);
      }
      if (!item.name.endsWith('.html') && !item.name.endsWith('.ts')) {
        return [];
      }
      if (item.name.endsWith('.spec.ts')) {
        return [];
      }
      return [{ path, text: withoutComments(readFileSync(path, 'utf8')) }];
    });
  }

  it('is opted into by every screen that opens a modal', () => {
    const missing: string[] = [];

    for (const { path, text } of templates()) {
      for (const match of text.matchAll(/<app-modal-sheet\b([\s\S]*?)>/g)) {
        if (!match[1].includes('animate.leave="modal--leaving"')) {
          missing.push(shortPath(path));
        }
      }
    }

    expect(missing, 'a modal that closes without its leave class simply stops fading').toEqual([]);
  });

  /** And the two overlays that own their own removal keep theirs, plus the class it names. */
  it('is wired into the popover and the column menu, with the class each names', () => {
    const popover = withoutComments(
      readFileSync(join(SRC, 'app', 'ui', 'info-popover.ts'), 'utf8'),
    );
    const menu = withoutComments(readFileSync(join(SRC, 'app', 'ui', 'column-menu.ts'), 'utf8'));

    expect(popover).toContain('animate.leave="pop--out"');
    expect(popover).toContain('.pop--out {');
    expect(menu).toContain('animate.leave="menu--out"');
    expect(menu).toContain('.menu--out {');
  });

  /**
   * **The exit has to outrank the enter, and here that is a matter of declaration order.**
   *
   * Home's project sheet takes all three of its animations from global single-class rules
   * (`overlay-scrim`, `overlay-sheet`, `overlay-out`), so the exit wins only because it is declared
   * last. Move the enter into `home-page.css` and it carries Angular's `[_ngcontent]` attribute,
   * outranks the global exit, and **the enter replays as the sheet is being removed** — the sheet
   * fades back *in* and then vanishes. That is not a hypothesis: a browser run reported
   * `animationName: teren-fade-in` on the leaving element. `!important` would fix it and break
   * something worse, since it would outrank the reduced-motion rule too.
   */
  it('declares the overlay exit after the two enters, and leaves them global', () => {
    const stylesheet = withoutComments(readFileSync(GLOBAL_STYLESHEET, 'utf8'));
    const scrim = stylesheet.indexOf('.overlay-scrim {');
    const sheet = stylesheet.indexOf('.overlay-sheet {');
    const out = stylesheet.indexOf('.overlay-out {');

    expect(scrim, 'styles.css no longer declares .overlay-scrim').toBeGreaterThan(-1);
    expect(out, 'the exit must be declared after both enters or it loses the tie').toBeGreaterThan(
      Math.max(scrim, sheet),
    );

    // And the enters must not migrate back into the component, where they would win.
    const home = withoutComments(
      readFileSync(join(SRC, 'app', 'features', 'home', 'home-page.css'), 'utf8'),
    );
    const sheetRules = home.slice(home.indexOf('.sheet {'), home.indexOf('.sheet__title'));

    expect(sheetRules, 'an animation on .sheet outranks the global exit class').not.toContain(
      'animation:',
    );
  });

  /**
   * A fading panel that still takes clicks sits over the rows the reader is going back to — the
   * half of an exit animation that is a defect rather than a decoration.
   */
  it('makes a leaving overlay click-through', () => {
    for (const file of ['ui/info-popover.ts', 'ui/column-menu.ts', 'ui/modal-sheet.ts']) {
      const text = withoutComments(readFileSync(join(SRC, 'app', ...file.split('/')), 'utf8'));
      const leaving = text.slice(text.indexOf('teren-pop-out'));

      expect(leaving.slice(0, 200), `${file} keeps a leaving overlay clickable`).toContain(
        'pointer-events: none',
      );
    }
  });
});

/**
 * The route cross-fade, and the fallback that matters more than it does.
 *
 * `withViewTransitions()` is provided in `app.config.ts`. In this suite — and in Firefox, and in
 * older Safari — `document.startViewTransition` does not exist, and Angular is supposed to run an
 * ordinary navigation instead. A cosmetic feature that could break navigation where it is
 * unsupported would be an unacceptable trade in a product whose whole job is to work on whatever
 * phone the foreman has, so it is pinned rather than assumed.
 */
@Component({ selector: 'app-motion-a', template: 'A' })
class MotionA {}

@Component({ selector: 'app-motion-b', template: 'B' })
class MotionB {}

@Component({ selector: 'app-motion-shell', imports: [RouterOutlet], template: '<router-outlet />' })
class MotionShell {}

describe('withViewTransitions', () => {
  it('is what the application actually provides', () => {
    const config = readFileSync(join(SRC, 'app', 'app.config.ts'), 'utf8');
    const providers = withoutComments(config);

    expect(providers).toContain('withViewTransitions()');
    // The other two options are load-bearing and easy to lose in a one-line edit to this call.
    expect(providers).toContain('withComponentInputBinding()');
  });

  it('styles the cross-fade from the tokens, on both snapshots', () => {
    const stylesheet = withoutComments(readFileSync(GLOBAL_STYLESHEET, 'utf8'));

    expect(stylesheet).toContain('::view-transition-old(root)');
    expect(stylesheet).toContain('::view-transition-new(root)');
    expect(stylesheet).toContain('animation-duration: var(--motion-slow)');
    expect(stylesheet).toContain('animation-timing-function: var(--ease-standard)');
  });

  it('navigates normally where the browser cannot animate a route change', async () => {
    // The premise of the test, asserted rather than assumed: if a future jsdom grows the function,
    // this stops being a fallback test and somebody should know.
    expect(
      (document as Document & { startViewTransition?: unknown }).startViewTransition,
      'jsdom has grown startViewTransition; this spec no longer pins the fallback',
    ).toBeUndefined();

    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'a', component: MotionA },
            { path: 'b', component: MotionB },
          ],
          withViewTransitions(),
        ),
      ],
    });

    const router = TestBed.inject(Router);
    const fixture = TestBed.createComponent(MotionShell);

    expect(await router.navigateByUrl('/a')).toBe(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('A');

    // The second navigation is the one that would hang or reject if the fallback were missing:
    // the first has no outgoing screen to snapshot.
    expect(await router.navigateByUrl('/b')).toBe(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('B');
    expect(router.url).toBe('/b');
  });
});
