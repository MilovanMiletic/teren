import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A shared class name with no shared stylesheet is markup that lies.
 *
 * `.field__input` is written in seven templates across four features. Angular scopes a component's
 * styles to that component, so copying the markup carries the class and none of the rules — and
 * that is not hypothetical: `/platform`'s "add a person" and `/platform/companies`' "add a
 * customer" both shipped, reviewed and green, with bare browser-default inputs, the label sitting
 * beside the box instead of above it. The founder photographed one of them on 2026-09-01.
 *
 * Nothing could have caught it. The specs assert behaviour and render the component with its real
 * stylesheet, which is the *missing* one; the visual pass at F7 opened `/platform` but not the
 * dialog inside it. So this reads the shipped source off disk instead: for every template that
 * writes `field__input`, resolve its component's stylesheets and require that at least one of them
 * actually defines the class.
 *
 * It is deliberately about the *class*, not about which file provides it. `ui/field.css` serves
 * the admin dialogs, `auth-form.css` the sign-in screens and `confirm-page.css` the dense
 * confirmation grid — three genuinely different controls that happen to share a name. Requiring
 * one file would force a merge that makes a change to one screen break two others.
 */

const FEATURES = resolve(__dirname, '..', 'features');

/** Every `.html` under `src/app/features`, with its text. */
function templates(): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.html')) {
        found.push({ path: full, text: readFileSync(full, 'utf8') });
      }
    }
  };

  walk(FEATURES);
  return found;
}

/**
 * The stylesheets a component declares, as absolute paths.
 *
 * Both spellings, because Angular accepts both and the difference is exactly what changed here:
 * `styleUrl` is the single-sheet form these screens were written with, and adding a shared sheet
 * means moving to `styleUrls`. A scan that knew only one of them would go quiet at the moment the
 * file it is guarding gained a second stylesheet.
 */
function stylesheetsOf(componentPath: string): string[] {
  const source = readFileSync(componentPath, 'utf8');
  const single = /styleUrl:\s*(['"])([^'"]+)\1/.exec(source);
  const many = /styleUrls:\s*\[([^\]]*)\]/.exec(source);

  const declared = single
    ? [single[2]]
    : [...(many?.[1] ?? '').matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2]);

  return declared.map((relative) => resolve(dirname(componentPath), relative));
}

describe('the shared field class', () => {
  it('is defined by a stylesheet of every component that writes it', () => {
    const users = templates().filter(({ text }) => text.includes('field__input'));

    // If the scan itself stops finding templates, this becomes a spec that asserts nothing while
    // passing. A floor under it, checked against the tree.
    expect(users.length, 'no template writes field__input — has the scan broken?').toBeGreaterThan(
      4,
    );

    const unstyled: string[] = [];

    for (const { path } of users) {
      const component = path.replace(/\.html$/, '.ts');
      if (!existsSync(component)) {
        unstyled.push(`${path} has no sibling component`);
        continue;
      }

      const sheets = stylesheetsOf(component);
      const defines = sheets.some(
        (sheet) => existsSync(sheet) && readFileSync(sheet, 'utf8').includes('.field__input'),
      );

      if (!defines) {
        unstyled.push(component);
      }
    }

    expect(
      unstyled,
      'these components write class="field__input" and none of their stylesheets defines it — the input will render as a browser default',
    ).toEqual([]);
  });
});
