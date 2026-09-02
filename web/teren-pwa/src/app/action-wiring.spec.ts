import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ACTION_VOCABULARY, ACTIONS } from './core/telemetry/actions';
import { isAction } from './core/telemetry/client-event';

/**
 * The action log's wiring, guarded at the source.
 *
 * ## Why a scan and not only component specs
 *
 * A `data-log` attribute is the cheapest way to name a control for the log — no component change,
 * no handler, the descriptor picks it up — and it is exactly as cheap to lose. It has no type, no
 * consumer inside the component, and no test of its own unless somebody writes one: a refactor
 * that rewrites a template keeps every assertion in that screen's spec green while the log quietly
 * goes back to saying `ui.button.btn`. **This feature cannot detect its own absence**, which is the
 * whole reason the increment it belongs to exists.
 *
 * So the declarations are pinned twice. Here, structurally: every slug that ships is a member of
 * the vocabulary, sits on something that is actually a control, and is present on the screen that
 * is supposed to carry it. And behaviourally, in each screen's own spec, where the control is
 * rendered and `describeClick` is asked what it is called — because a slug on the wrong element,
 * or nine levels above the button, would satisfy this file and record nothing.
 *
 * The counterpart for the hand-written `actions.record(...)` calls is the same: this file proves
 * the call site exists in the file that owns the action, and the screen's spec proves it fires with
 * the right outcome.
 */

/** Every source file of the app — templates included, specs excluded. */
function sourceFiles(dir = join(process.cwd(), 'src', 'app')): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      return sourceFiles(path);
    }
    if (item.name.endsWith('.spec.ts') || !/\.(ts|html)$/.test(item.name)) {
      return [];
    }
    // Comments go first, everywhere. `action-descriptor.ts` *documents* the attribute it reads,
    // and a guard that fails on prose about itself is a guard somebody deletes.
    const text = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    return [{ path, text }];
  });
}

/** `src/app/features/home/home-page.html`, so a failure names the file the way a person would. */
function shortPath(path: string): string {
  return relative(join(process.cwd(), 'src', 'app'), path);
}

/** One `data-log="…"` declaration, with the tag it sits on. */
interface Declaration {
  readonly slug: string;
  readonly tag: string;
  readonly file: string;
}

const LOG_ATTRIBUTE = /data-log="([^"]*)"/g;

/**
 * The tag a `data-log` sits on, found by walking back to the `<` that opened it.
 *
 * Crude on purpose — a real parser is not worth it for one attribute — and safe in the direction
 * that matters: an attribute in a comment or a string would resolve to something absurd and fail
 * the check below rather than pass it silently.
 */
function openingTag(text: string, at: number): string {
  const open = text.lastIndexOf('<', at);
  return open === -1 ? '' : (/^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(open, at))?.[1] ?? '');
}

function declarations(): Declaration[] {
  const found: Declaration[] = [];
  for (const { path, text } of sourceFiles()) {
    for (const match of text.matchAll(LOG_ATTRIBUTE)) {
      found.push({
        slug: match[1],
        tag: openingTag(text, match.index).toLowerCase(),
        file: shortPath(path),
      });
    }
  }
  return found;
}

/**
 * What must be declared where.
 *
 * Keyed on the file rather than on the slug because a slug legitimately appears in several places
 * — `confirm.open` is on the archive row *and* on both of the record's ways into the gate — and
 * losing one of them is a hole the log cannot report. Every entry here is a control a person
 * presses on a real screen; the file is named so a failure says where to go.
 */
const DECLARED: readonly { file: string; slug: string }[] = [
  { file: 'features/capture/capture-recording-page.html', slug: ACTIONS.captureRecordDiscard },
  { file: 'features/capture/capture-saved-page.html', slug: ACTIONS.captureSend },
  { file: 'features/home/home-page.html', slug: ACTIONS.archiveOpen },
  { file: 'features/archive/archive-page.html', slug: ACTIONS.archiveEntryOpen },
  { file: 'features/archive/archive-page.html', slug: ACTIONS.confirmOpen },
  { file: 'features/archive/entry-detail.html', slug: ACTIONS.confirmOpen },
  { file: 'features/archive/entry-detail.html', slug: ACTIONS.archiveMediaOpen },
  { file: 'features/company/company-page.html', slug: ACTIONS.companyWorkerOpen },
  { file: 'features/company/worker-page.html', slug: ACTIONS.companyCodeReveal },
];

/**
 * What must be recorded by hand, and where.
 *
 * An outcome or a duration is the only thing that earns a call in a handler — a click cannot say
 * whether the server accepted the confirmation, or how long the take was. Anything else belongs on
 * the control as an attribute, where it costs no code on the money path.
 */
const RECORDED: readonly { file: string; member: keyof typeof ACTIONS }[] = [
  { file: 'features/capture/capture-recording-page.ts', member: 'captureRecordStart' },
  { file: 'features/capture/capture-recording-page.ts', member: 'captureRecordStop' },
  { file: 'features/capture/capture-saved-page.ts', member: 'capturePhotoAdd' },
  { file: 'features/home/home-page.ts', member: 'confirmOpen' },
  { file: 'features/home/home-page.ts', member: 'archiveEntryOpen' },
  { file: 'features/archive/entry-detail.ts', member: 'archiveReportDownload' },
  { file: 'features/confirm/confirm-page.ts', member: 'confirmEdit' },
  { file: 'features/confirm/confirm-page.ts', member: 'confirmSend' },
  { file: 'features/confirm/confirm-page.ts', member: 'confirmVerbatim' },
  { file: 'features/company/company-page.ts', member: 'companyWorkerAdd' },
  { file: 'features/company/worker-page.ts', member: 'companyCodeIssue' },
  { file: 'features/auth/login-page.ts', member: 'sessionLogin' },
  { file: 'features/auth/activate-page.ts', member: 'sessionActivate' },
  { file: 'ui/session-link.ts', member: 'sessionLogout' },
];

/**
 * The tags a declaration may sit on.
 *
 * `button`, `a`, `summary`, `input` and `label` are what `action-descriptor.ts` counts as
 * actionable in the first place. `tr` is here because the people table's whole row is the control
 * — the click handler is on it, and the button inside the name cell is the keyboard's way in — and
 * a declaration on an ancestor is found by the same bounded walk. A `div` is not on the list: a
 * slug on a wrapper swallows every press inside it, including the ones that are a different
 * action.
 */
const CONTROL_TAGS = new Set(['button', 'a', 'summary', 'input', 'label', 'tr']);

describe('the action log wiring', () => {
  const declared = declarations();

  it('declares only slugs the server would accept', () => {
    expect(declared.length).toBeGreaterThan(0);
    for (const item of declared) {
      expect(ACTION_VOCABULARY, `${item.file} declares "${item.slug}"`).toContain(item.slug);
      // Belt and braces: the vocabulary is checked against the contract's own pattern elsewhere,
      // and a declaration that fails it is dropped silently by the descriptor rather than sent.
      expect(isAction(item.slug), `${item.file} declares "${item.slug}"`).toBe(true);
    }
  });

  /**
   * A slug on a `<div>` is worse than no slug at all: `declaredSlug` walks up to eight levels, so
   * a wrapper's declaration is claimed by every control inside it — the delete button as well as
   * the open button, the cancel as well as the confirm.
   */
  it('declares them on controls, never on wrappers', () => {
    for (const item of declared) {
      expect(CONTROL_TAGS, `${item.file} declares "${item.slug}" on <${item.tag}>`).toContain(
        item.tag,
      );
    }
  });

  it('carries every declaration the screens are supposed to have', () => {
    for (const { file, slug } of DECLARED) {
      const here = declared.filter((item) => item.file === file && item.slug === slug);
      expect(here.length, `${file} must declare data-log="${slug}"`).toBeGreaterThan(0);
    }
  });

  it('records by hand exactly where an outcome or a duration is the point', () => {
    const files = new Map(sourceFiles().map(({ path, text }) => [shortPath(path), text]));
    for (const { file, member } of RECORDED) {
      const text = files.get(file);
      expect(text, `${file} is missing`).toBeDefined();
      expect(text, `${file} must record ACTIONS.${member}`).toContain(`ACTIONS.${member}`);
    }
  });

  /**
   * **The one that would have caught the original defect.**
   *
   * The vocabulary shipped complete and almost entirely unwired: no template carried a `data-log`
   * attribute and the only hand-recorded slugs were the log screen's own three, so 26 of the 33
   * names here could never be emitted by anything. Every spec passed, because each one asked
   * whether what *is* wired is wired correctly — and none asked whether a declared name is
   * reachable at all. The founder would have opened his new screen and read
   * `ui.app-capture-page.button.btn` for the whole money path.
   *
   * So: every member of `ACTIONS` must be emitted from somewhere — a `data-log` declaration, a
   * hand-written `record()` call, or the service itself for the five it raises on its own. A slug
   * nobody can produce is a promise the log stream does not keep, and adding one is now a red
   * spec rather than a discovery six weeks later.
   */
  it('can actually emit every slug in the vocabulary', () => {
    const declaredSlugs = new Set(declarations().map((item) => item.slug));

    // Every `ACTIONS.member` mentioned anywhere outside the vocabulary file and the specs.
    const members = new Set<string>();
    for (const { path, text } of sourceFiles()) {
      if (shortPath(path).endsWith('actions.ts')) {
        continue;
      }
      for (const match of text.matchAll(/ACTIONS\.([A-Za-z0-9_]+)/g)) {
        members.add(match[1]);
      }
    }

    const orphans = Object.entries(ACTIONS)
      .filter(([member, slug]) => !members.has(member) && !declaredSlugs.has(slug))
      .map(([member, slug]) => `${member} (${slug})`)
      .sort();

    expect(orphans, 'declared in the vocabulary but nothing can emit it').toEqual([]);
  });

  it('scans enough of the app for that to mean anything', () => {
    // Anti-vacuity: a wrong root or a changed glob would make the assertion above pass over an
    // empty tree, which is exactly the silence it exists to break.
    expect(Object.keys(ACTIONS).length).toBeGreaterThan(20);
    expect(sourceFiles().length).toBeGreaterThan(50);
    expect(declarations().length).toBeGreaterThan(5);
  });
});
