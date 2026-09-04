import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * **Drawn small, hit large** — as a property of the shipped stylesheets rather than of anybody's
 * memory.
 *
 * `design/tokens.md` sets 44 px as the floor for a control, and the product breaks it on purpose
 * in several places: five 44 px discs in a row read as a slab rather than as a pager, and the
 * funnel beside a column label would swallow the label. The rule that makes that safe is the one
 * `ui/column-menu.ts` wrote down first — draw the ink at 28 or 36 or 40, and extend the *target*
 * back out to 44 with an absolutely-positioned `::after` on a negative inset.
 *
 * It is a rule nothing enforced, and it duly lapsed in four places at once: the log line's
 * chevron, both of the app header's controls, and the language switcher on that header —
 * every one of them on a screen an owner reaches on a phone. A review found them by reading;
 * the next four will be introduced the same way, one plausible `height: 36px` at a time.
 *
 * ## What this spec does
 *
 * It reads every stylesheet that ships — the `.css` files and the `styles:` blocks of the
 * components that keep their CSS inline — pulls out every rule that draws something under
 * 44 px in either axis, and insists that each one either **carries an extended hit area**
 * or is **named below as something a thumb never presses**.
 *
 * The exemption list is the point of the design, not a hole in it. There is no way to tell a
 * control from a decoration by reading CSS — a 36 px square is the stop button's glyph in
 * one file and a live chevron in another — so the choice is made once, in writing, by
 * whoever adds the rule. Adding a small control without thinking about it fails here; adding a
 * small *decoration* costs one line and a reason.
 */

/** `design/tokens.md`: the floor for anything a thumb has to land on. */
const TAP_MIN = 44;

/**
 * Things drawn under 44 px that no thumb ever presses, and why.
 *
 * Keyed by `file | selector`, so the same class name in two files is two decisions. A reason that
 * stops being true is a line to delete, which is the review this list is for.
 */
const DRAWN_NOT_PRESSED: Record<string, string> = {
  'styles.css | .visually-hidden': 'a screen-reader-only clip rectangle; it is never painted',
  'styles.css | .skeleton':
    'a loading placeholder — it is what stands in for content, not a control',
  'styles.css | .skeleton--head': 'the same placeholder, one size up',
  'styles.css | .skeleton--row': 'the same placeholder, one size up again',
  'app/features/auth/auth-form.css | .form__divider-line': 'a 1 px hairline between two blocks',
  'app/features/archive/entry-detail.css | .detail__progress':
    'the download progress bar — it reports, it is not pressed',
  'app/features/capture/capture-recording-page.css | .rec-badge__dot':
    'the pulsing dot inside the recording badge',
  'app/features/capture/capture-recording-page.css | .wave__bar':
    'one bar of the level meter — it shows the microphone is hearing him, nothing more',
  'app/features/capture/capture-recording-page.css | .stop__square':
    'the glyph inside the 128 px stop button; the button is the target and it is enormous',
};

/** Every stylesheet that ships, as text: the `.css` files and the inline `styles:` blocks. */
function stylesheets(): { file: string; css: string }[] {
  const root = join(process.cwd(), 'src');
  const sheets: { file: string; css: string }[] = [];

  for (const path of walk(root)) {
    const file = relative(root, path).split(sep).join('/');
    if (path.endsWith('.css')) {
      sheets.push({ file, css: readFileSync(path, 'utf8') });
      continue;
    }
    // A component that keeps its CSS inline. The template literal ends at the backtick that
    // closes the `styles:` property — which is why no such block may contain a backtick.
    const source = readFileSync(path, 'utf8');
    const match = /styles:\s*`([\s\S]*?)`,\s*\r?\n/.exec(source);
    if (match) {
      sheets.push({ file, css: match[1] });
    }
  }
  return sheets;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      walk(path, acc);
    } else if (/\.css$/.test(item.name) || /(?<!\.spec)\.ts$/.test(item.name)) {
      acc.push(path);
    }
  }
  return acc;
}

interface Rule {
  selectors: string[];
  body: string;
}

/**
 * The innermost rule blocks of a stylesheet.
 *
 * A regex rather than a parser, and the shape of it is what makes that honest: `[^{}]` on both
 * sides means it can only ever match a block with no braces inside it, so a rule nested in an
 * `@media` is found and the `@media` wrapper itself is not. Comments go first, or a brace in prose
 * would split a rule in two.
 */
function rules(css: string): Rule[] {
  const found: Rule[] = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@') || selector.length === 0) {
      continue;
    }
    found.push({
      selectors: selector
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean),
      body: match[2],
    });
  }
  return found;
}

/**
 * Every `height` / `width` (or `min-`) in the block that is under the floor, in px.
 *
 * **`calc(var(--tap-min) - …)` counts as under it too**, and that clause is not decoration: it is
 * how `ui/column-menu.ts`'s sort label is written, and without it this guard read a literal-px
 * regex over a rule with no literal px in it and passed in silence over the very control the
 * pattern was invented for (review, 2026-09-04). Anything that *subtracts* from the floor is
 * below the floor by construction, so the arithmetic does not need doing — the hit area does.
 */
function undersized(body: string): number[] {
  const literal = [...body.matchAll(/(?:^|;)\s*(?:min-)?(?:height|width)\s*:\s*(\d+)px/g)]
    .map((match) => Number(match[1]))
    .filter((px) => px < TAP_MIN);
  const derived = [
    ...body.matchAll(/(?:^|;)\s*(?:min-)?(?:height|width)\s*:\s*calc\(\s*var\(--tap-min\)\s*-/g),
  ].map(() => TAP_MIN - 1);
  return [...literal, ...derived];
}

/**
 * Whether the sheet extends this selector's target back out with a pseudo-element.
 *
 * Matched on the selector *text* — `.pager__step` finding `.pager__step::after` — because
 * that is the coupling the pattern actually has. A negative inset is required, not merely
 * an `::after`: the pseudo-elements that draw a divider or an arrow are also `::after`, and
 * one of those beside a 36 px button would read as a hit area that is not there.
 */
function hitAreaFor(selector: string, all: Rule[]): boolean {
  return all.some(
    (rule) =>
      rule.selectors.some((one) => one === `${selector}::after` || one === `${selector}::before`) &&
      /inset\s*:\s*[^;]*-\d/.test(rule.body),
  );
}

describe('tap targets', () => {
  const sheets = stylesheets();

  it('reads the stylesheets that actually ship', () => {
    // A guard on the guard: a moved folder or a changed `styles:` shape would leave every
    // assertion below passing over an empty set, in perfect silence.
    expect(sheets.length).toBeGreaterThan(20);
    expect(sheets.map((sheet) => sheet.file)).toContain('styles.css');
    expect(sheets.map((sheet) => sheet.file)).toContain('app/ui/column-menu.ts');
    expect(sheets.some((sheet) => /\.more\s*\{/.test(sheet.css))).toBe(true);
  });

  it('gives every control drawn under 44 px a target that is 44 px', () => {
    const offenders: string[] = [];

    for (const { file, css } of sheets) {
      const all = rules(css);
      for (const rule of all) {
        if (undersized(rule.body).length === 0) {
          continue;
        }
        for (const selector of rule.selectors) {
          if (DRAWN_NOT_PRESSED[`${file} | ${selector}`] || hitAreaFor(selector, all)) {
            continue;
          }
          offenders.push(
            `${file}  ${selector}  (${undersized(rule.body).join(', ')}px) — add an ` +
              `::after { inset: -Npx } hit area, or name it in DRAWN_NOT_PRESSED with a reason`,
          );
        }
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * **The column label, by name**, because it is the control this whole pattern was written for
   * and the one the sweep above could not see until `undersized` learned to read a `calc`.
   *
   * A column heading is drawn as a word — 16 px for "Od" at 360, measured — and sorted with one
   * tap, which makes it the most-pressed small control in the product. It is drawn at 36 and hit
   * at 44, leftwards into the component's own padding: the funnel is its next sibling and owns
   * the 8 px on the other side.
   */
  it('extends the column label’s target, which is drawn as narrow as its word', () => {
    const sheet = sheets.find((one) => one.file === 'app/ui/column-menu.ts');
    expect(sheet, 'ui/column-menu.ts is no longer read as a stylesheet').toBeTruthy();
    const all = rules(sheet!.css);

    const sort = all.find((rule) => rule.selectors.includes('.sort'));
    expect(sort, 'the .sort rule has moved or been renamed').toBeTruthy();
    expect(undersized(sort!.body).length, '.sort no longer draws under the floor').toBeGreaterThan(
      0,
    );
    expect(hitAreaFor('.sort', all), '.sort is drawn small and hit small').toBe(true);
    // Leftwards only: an overhang the other way sits on the funnel's own 44 px area.
    const after = all.find((rule) => rule.selectors.includes('.sort::after'));
    expect(after!.body).toMatch(/inset\s*:\s*0 0 0 calc\(-1 \* var\(--space-2\)\)/);
  });

  it('keeps the exemption list honest — every entry still names a real rule', () => {
    // An exemption whose selector has been renamed or deleted is a line that will sit here for
    // ever exempting nothing, and the next author reads it as precedent.
    const live = new Set<string>();
    for (const { file, css } of sheets) {
      for (const rule of rules(css)) {
        if (undersized(rule.body).length === 0) {
          continue;
        }
        for (const selector of rule.selectors) {
          live.add(`${file} | ${selector}`);
        }
      }
    }

    expect(Object.keys(DRAWN_NOT_PRESSED).filter((key) => !live.has(key))).toEqual([]);
  });
});
