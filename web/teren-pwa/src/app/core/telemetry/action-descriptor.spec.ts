import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAction } from './client-event';
import { UNNAMED_CLICK, describeClick } from './action-descriptor';

/** A project name and an address, which is what the labels on this product's screens say. */
const SITE = 'Vojvode Stepe 212';
const OWNER = 'Petar Petrović';

/**
 * The descriptor's own source, with its comments removed.
 *
 * Comments are stripped because this file's comments explain *why* `textContent` and the rest are
 * forbidden, and a scan that read them would fail on the explanation rather than on the code.
 */
function code(): string {
  const source = readFileSync(
    join(process.cwd(), 'src', 'app', 'core', 'telemetry', 'action-descriptor.ts'),
    'utf8',
  );
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every attribute name `getAttribute(…)` is called with, exactly as it is written. */
function attributeReads(source: string): string[] {
  return [...source.matchAll(/getAttribute\(([^)]*)\)/g)].map((match) => match[1].trim());
}

function dom(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('naming what was clicked', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('a control that declares itself', () => {
    it('sends the declared slug verbatim', () => {
      const host = dom('<button data-log="capture.record.start">Snimi</button>');
      expect(describeClick(host.querySelector('button'))).toBe('capture.record.start');
    });

    it('finds a declaration on an ancestor, so an icon inside a button still names it', () => {
      const host = dom(
        '<button data-log="logs.export"><app-icon><svg><path></path></svg></app-icon></button>',
      );
      expect(describeClick(host.querySelector('path'))).toBe('logs.export');
    });

    /**
     * A typo in a template must not cost the press.
     *
     * The server refuses a malformed action whole, so an invalid declaration is ignored here and
     * the structural descriptor stands in — a worse name, and a name that arrives.
     */
    it('ignores a declaration the server would refuse and falls back to the shape', () => {
      const host = dom('<button data-log="Capture Record Start" class="btn">x</button>');
      expect(describeClick(host.querySelector('button'))).toBe('ui.button.btn');
    });
  });

  describe('everything else', () => {
    it('names the component, the tag and the class', () => {
      const host = dom(
        '<app-column-menu><button class="more more--on">x</button></app-column-menu>',
      );
      expect(describeClick(host.querySelector('button'))).toBe('ui.app-column-menu.button.more');
    });

    it('names a bare control when there is no component around it', () => {
      const host = dom('<button class="btn btn--primary">x</button>');
      expect(describeClick(host.querySelector('button'))).toBe('ui.button.btn');
    });

    it('always produces something the server will accept', () => {
      const host = dom(
        '<app-session-link><a href="/login" class="notice__title">x</a></app-session-link>',
      );
      const action = describeClick(host.querySelector('a'));
      expect(action).not.toBeNull();
      expect(isAction(action as string), action as string).toBe(true);
      // `__` is not in the contract's segment alphabet and the class is worth keeping anyway.
      expect(action).toBe('ui.app-session-link.a.notice--title');
    });

    /**
     * A log of every mouse-down on a paragraph is noise that hides the presses that matter — and
     * on a phone, where a tap on the page background is how a menu is dismissed, it would be most
     * of the log.
     */
    it('says nothing about a click that was not on a control', () => {
      const host = dom(`<p class="t-meta">${SITE}</p>`);
      expect(describeClick(host.querySelector('p'))).toBeNull();
      expect(describeClick(null)).toBeNull();
    });

    it('has a fallback that is itself a valid action', () => {
      expect(isAction(UNNAMED_CLICK)).toBe(true);
    });
  });

  /**
   * ## The privacy boundary, asserted rather than documented
   *
   * Every accessor below returns a **translated, user-facing string**, and on this product's
   * screens two of them carry a customer's project name: `platform.person.open` is "Open {{name}}"
   * and the archive names an address. A descriptor built from any of them would ship a customer's
   * commercial data into a log table Teren staff can read — which is precisely what
   * `PlatformPrivacyTests` makes impossible on the server side, and what would be undone here.
   */
  describe('what a descriptor may never contain', () => {
    it('ignores the text, the label, the title and the value, all at once', () => {
      const host = dom(
        `<app-header><button class="btn-icon" aria-label="Open ${OWNER}" title="${SITE}"` +
          ` value="${SITE}">${SITE}</button></app-header>`,
      );

      const action = describeClick(host.querySelector('button')) as string;

      expect(action).toBe('ui.app-header.button.btn-icon');
      for (const secret of [SITE, OWNER, 'vojvode', 'petrovic', 'petrović']) {
        expect(action.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    });

    it('ignores an input the foreman has typed into', () => {
      const host = dom('<input class="field__input" type="text" />');
      const input = host.querySelector('input') as HTMLInputElement;
      input.value = 'Zamenjena je slavina u kupatilu';

      const action = describeClick(input) as string;

      expect(action).toBe('ui.input.field--input');
      expect(action).not.toContain('slavina');
    });

    /**
     * **The guard on the guard.**
     *
     * The two cases above pass for a file that reads `textContent` and happens to be handed an
     * element whose text is not in the descriptor — a truncation, a lower-casing, a class that won
     * the race. This one fails on the *reach*, not on the result, which is the only way to keep a
     * future edit ("just add the label, the logs are unreadable") from looking like an
     * improvement. It is the same source-scanning discipline `company-page.spec.ts` uses to keep
     * an activation code off a list.
     */
    it('reads only the two attributes it is allowed to read', () => {
      // An allow-list, and deliberately not a list of banned words. A deny-list is only ever as
      // good as the imagination of the person who wrote it: the first cut of this scan named nine
      // substrings and let `getAttribute('title')`, `getAttribute('value')` and
      // `getAttribute('alt')` straight through, because none of them is spelled `.title`. There
      // are exactly two attributes on an element that are not content — the slug this repo puts
      // there itself, and the class names its own stylesheets put there — so those two are named
      // and everything else is refused by construction.
      const reads = attributeReads(code());
      // A scan that found nothing has stopped scanning, which is how a source-scanning guard dies
      // quietly: the file moves, the read still succeeds, and the loop below runs zero times.
      expect(
        reads.length,
        'no getAttribute call found — has the descriptor moved?',
      ).toBeGreaterThan(0);

      for (const argument of reads) {
        expect(
          ["'data-log'", '"data-log"', "'class'", '"class"'],
          `action-descriptor.ts reads the ${argument} attribute`,
        ).toContain(argument);
      }
    });

    it('never reaches for a user-facing string at all', () => {
      const source = code();

      // Raw words that have no innocent reading in this file at all.
      for (const forbidden of [
        'textContent',
        'innerText',
        'innerHTML',
        'outerHTML',
        'aria-label',
        'ariaLabel',
        'accessibleName',
        'placeholder',
        'getAttributeNode',
      ]) {
        expect(source, `action-descriptor.ts reaches for ${forbidden}`).not.toContain(forbidden);
      }

      /*
       * And the accessors, as *property reads* rather than as substrings.
       *
       * The dotted and the bracketed form of each, because `dataset['label']` reaches the same
       * translated string as `.title` does and is not spelled like it. Matching the property read
       * rather than the bare word is what lets this file keep the two innocent occurrences it
       * genuinely needs: `tagName` is not `.name`, and `a[href]` inside the selector of things a
       * person can press is a tag test, not an accessor.
       */
      for (const property of [
        'dataset',
        'title',
        'value',
        'alt',
        'name',
        'href',
        'label',
        'attributes',
        'nodeValue',
        'data',
      ]) {
        const dotted = new RegExp('\\.' + property + '\\b');
        const bracketed = new RegExp('\\[\\s*[\'"]' + property + '[\'"]\\s*\\]');
        expect(dotted.test(source), `action-descriptor.ts reads .${property}`).toBe(false);
        expect(bracketed.test(source), `action-descriptor.ts reads ['${property}']`).toBe(false);
      }
    });
  });
});
