import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import en from '../../public/i18n/en.json';
import sr from '../../public/i18n/sr.json';
import { FAILURE_KINDS } from './core/api/api-failure';
import { AUTH_FAILURES } from './core/auth/activation.service';
import { CONFIRM_BANNERS } from './core/confirm/confirm-banner';
import { CONFIRM_FAILURES } from './core/confirm/confirm.service';
import { REPORT_FAILURES } from './core/report/report.service';
import { REASON_KEYS } from './features/pending/pending-page';
import { AVAILABLE_LANGUAGES, DEFAULT_LANGUAGE } from './i18n';

/**
 * Every source file of the app, read off disk.
 *
 * The suite runs on jsdom under Node, so this reads the files that actually ship rather than a
 * bundler's snapshot of them — and it needs no build-tool magic to do it.
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
    return [{ path, text: withoutComments(readFileSync(path, 'utf8')) }];
  });
}

/**
 * Drop comments before looking for keys.
 *
 * This codebase writes long doc comments that name keys in backticks — the very comment
 * explaining why `confirm.error.reported` went missing does it. Scanning those would make the
 * spec fail on prose, and prose that merely *mentions* a key is not a reference that can put a
 * raw key in front of a foreman. Only code and templates count.
 *
 * A `//` inside a string literal would cut that line short, which can only lose a reference and
 * never invent one — the safe direction for a guard to be imprecise in.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** The top-level blocks of the dictionary — read from the dictionary, never listed by hand. */
const NAMESPACES = Object.keys(en);

/**
 * A quoted string that is exactly a translation key: a dictionary namespace followed by at least
 * one dotted segment, and nothing else inside the quotes.
 *
 * Deliberately not `t\\(` — plenty of keys never appear next to the `t` call. `deliveredKey()`
 * returns `'archive.materials.delivered'` from a component method, and the template only ever
 * sees the value. Matching the *shape of a key* rather than the shape of a call site is what
 * makes this catch them.
 */
const KEY_LITERAL = new RegExp(
  '[\'"`](' + NAMESPACES.join('|') + ')((?:\\.[A-Za-z0-9_]+)+)[\'"`]',
  'g',
);

function referencedKeys(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const { path, text } of sourceFiles()) {
    for (const match of text.matchAll(KEY_LITERAL)) {
      found.push({ key: match[1] + match[2], file: basename(path) });
    }
  }
  return found;
}

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('translation dictionaries', () => {
  const srKeys = leafKeys(sr).sort();
  const enKeys = leafKeys(en).sort();

  it('define exactly the same keys — no user-facing string may exist in one language only', () => {
    expect(srKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
    expect(enKeys.filter((key) => !srKeys.includes(key))).toEqual([]);
  });

  it('leave nothing blank', () => {
    for (const dictionary of [sr, en]) {
      const empty = leafKeys(dictionary).filter((key) => !read(dictionary, key)?.trim());
      expect(empty).toEqual([]);
    }
  });

  it('carry every plural form both languages are looked up with', () => {
    for (const form of ['zero', 'one', 'few', 'other']) {
      expect(srKeys).toContain(`common.photos.${form}`);
      expect(enKeys).toContain(`common.photos.${form}`);
    }
  });

  /**
   * The general form of the defect the B5 review found.
   *
   * A key referenced by code but absent from the dictionaries does not fail a build, does not
   * throw, and does not fail any spec that happens not to walk that branch — Transloco simply
   * renders the key itself, so a foreman is shown `confirm.error.reported` where a sentence
   * should be. Reading the source and checking every key that is written out in full turns the
   * whole class of mistake into a red spec, for every screen at once and for keys yet unwritten.
   */
  it('has a string behind every key the source writes out in full', () => {
    const references = referencedKeys();
    // A guard on the guard: if the scan ever matches nothing — a moved folder, a changed glob —
    // it would pass in perfect silence while checking absolutely nothing.
    expect(references.length).toBeGreaterThan(50);

    // Resolving the path, not membership of the leaf list: a key may legitimately name a whole
    // block — `common.photos` is looked up by plural form, `capture.mic.denied` carries a title
    // and a body — and those are references that do land on something.
    const missing = references
      .filter(({ key }) => resolves(en, key) === false || resolves(sr, key) === false)
      .map(({ key, file }) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  /**
   * The same defect where the source *cannot* write the key out in full.
   *
   * `confirm-page.ts` builds `confirm.error.${failure}` from a union member, so no scan of string
   * literals can see the keys it produces — which is exactly how `'reported'` shipped with no
   * sentence behind it. The union is made enumerable at runtime (`CONFIRM_FAILURES`, kept
   * complete by a `Record<ConfirmFailure, true>` the compiler checks) so this spec can walk it.
   * Add a failure kind and this fails until both languages can name it.
   */
  it('can name every failure the confirmation service is able to return', () => {
    expect(CONFIRM_FAILURES.length).toBeGreaterThan(0);
    for (const failure of CONFIRM_FAILURES) {
      expect(enKeys).toContain(`confirm.error.${failure}`);
      expect(srKeys).toContain(`confirm.error.${failure}`);
    }
  });

  /**
   * The same guard for the sentence above the day.
   *
   * `confirm-page.html` builds `confirm.banner.<key>.title` by concatenation, so the literal scan
   * cannot see those keys either — and this block was just split from one banner into two
   * (`noStructure` / `noTranscript`) because the single one was telling a foreman his recording
   * could not be read while his words sat above the sentence. A split that renamed a key and
   * missed a dictionary would put `confirm.banner.noStructure.title` on screen instead.
   */
  it('can name every banner the confirmation screen is able to show', () => {
    expect(CONFIRM_BANNERS.length).toBeGreaterThan(0);
    for (const banner of CONFIRM_BANNERS) {
      for (const part of ['title', 'body']) {
        expect(enKeys).toContain(`confirm.banner.${banner}.${part}`);
        expect(srKeys).toContain(`confirm.banner.${banner}.${part}`);
      }
    }
  });

  /**
   * The same guard for the report download.
   *
   * `entry-detail.ts` builds `archive.report.error.${failure}` from a union member, exactly as the
   * confirmation screen does — and the three sentences that matter most here (not ready yet, no
   * such entry, the server could not be asked) are the ones a foreman would meet as raw keys if
   * either dictionary fell behind the union.
   */
  it('can name every failure the report download is able to return', () => {
    expect(REPORT_FAILURES.length).toBeGreaterThan(0);
    for (const failure of REPORT_FAILURES) {
      expect(enKeys).toContain(`archive.report.error.${failure}`);
      expect(srKeys).toContain(`archive.report.error.${failure}`);
    }
  });

  /**
   * The same guard for the reason under a stuck entry on the pending screen.
   *
   * `pending-page.ts` maps every `FailureKind` to a key through `REASON_KEYS`, and an unmapped
   * kind falls back to `pending.reason.unknown` — so a missing sentence does not throw, does not
   * fail a build, and does not fail any spec that happens not to walk that branch. It just tells a
   * foreman "Slanje nije uspelo iz nepoznatog razloga" about a failure the classifier had named
   * precisely, on the one screen whose whole job is to say what went wrong.
   *
   * `FAILURE_KINDS` is kept complete by a `Record<FailureKind, true>` the compiler checks, so
   * adding a kind fails here until both dictionaries can name it. F1's own `unauthenticated` went
   * in before this block existed; this is what stops the next one being noticed by a customer.
   */
  it('can name every failure the sync loop is able to record', () => {
    expect(FAILURE_KINDS.length).toBeGreaterThan(0);
    for (const kind of FAILURE_KINDS) {
      const key = REASON_KEYS[kind];
      expect(enKeys, `no English sentence for '${kind}'`).toContain(key);
      expect(srKeys, `no Serbian sentence for '${kind}'`).toContain(key);
      // …and it is a sentence about *this* kind, not the catch-all wearing a table's clothes.
      if (kind !== 'unknown') {
        expect(key, `'${kind}' falls back to the generic line`).not.toBe('pending.reason.unknown');
      }
    }
  });

  /**
   * The same guard for the two screens that stand between a person and the app (F3).
   *
   * `activate-page.ts` and `login-page.ts` build `auth.code.error.${failure}` and
   * `auth.login.error.${failure}` by concatenation, so the literal scan above cannot see a single
   * one of those keys. Both screens read from the *same* union deliberately — the server's verdict
   * is one thing, and what to say about it is two — so both prefixes are walked here. A raw
   * `auth.code.error.rejected` on screen is not a broken build; it is a man standing in a yard
   * with a code that does not work and a translation key where the reason should be.
   */
  it('can name every failure the auth screens are able to return, on both of them', () => {
    expect(AUTH_FAILURES.length).toBeGreaterThan(0);
    for (const failure of AUTH_FAILURES) {
      for (const screen of ['auth.code.error', 'auth.login.error']) {
        expect(enKeys, `no English sentence for '${screen}.${failure}'`).toContain(
          `${screen}.${failure}`,
        );
        expect(srKeys, `no Serbian sentence for '${screen}.${failure}'`).toContain(
          `${screen}.${failure}`,
        );
      }
    }
  });

  it('keeps Serbian the default runtime locale', () => {
    expect(DEFAULT_LANGUAGE).toBe('sr');
    expect(AVAILABLE_LANGUAGES).toContain('sr');
    expect(AVAILABLE_LANGUAGES).toContain('en');
  });
});

/** Whether a dotted key lands on anything at all — a string, or a block of them. */
function resolves(dictionary: unknown, key: string): boolean {
  const node = key
    .split('.')
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | undefined)?.[part],
      dictionary,
    );
  return node !== undefined;
}

function read(dictionary: unknown, key: string): string | undefined {
  return key
    .split('.')
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | undefined)?.[part],
      dictionary,
    ) as string | undefined;
}
