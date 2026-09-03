import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import en from '../../public/i18n/en.json';
import sr from '../../public/i18n/sr.json';
import { FAILURE_KINDS } from './core/api/api-failure';
import { AUTH_FAILURES } from './core/auth/activation.service';
import { COMPANY_STATUSES } from './core/company/company.service';
import { CONFIRM_BANNERS } from './core/confirm/confirm-banner';
import { CONFIRM_FAILURES } from './core/confirm/confirm.service';
import { PROFILE_ROLES } from './core/identity/profile.service';
import { REPORT_FAILURES } from './core/report/report.service';
import { COMPANY_REASON_KEYS } from './features/company/company-reason';
import { ACTION_VOCABULARY } from './core/telemetry/actions';
import { LOG_LEVELS, LOG_RANGES } from './features/platform/log-level';
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
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      /*
       * …and `data-log="capture.send"`, which is a wire slug and not a key.
       *
       * A control declares its own name for the action log (D5, `core/telemetry/`), and the
       * vocabulary happens to be spelled like a translation key. Nobody reads one; they travel to
       * `POST /api/client-events` and nowhere else. Stripped rather than exempting whole templates,
       * because the same file's real keys must still be checked.
       */
      .replace(/data-log\s*=\s*"[^"]*"/g, ' ')
  );
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

/**
 * The dotted literals that are **not** translation keys, however exactly they are shaped like one.
 *
 * D5's action vocabulary is a slug namespace — `capture.send`, `platform.user.open`, `app.start` —
 * and it collides by pure coincidence with the shape of a Transloco key. Those slugs go to
 * `POST /api/client-events` and nowhere else; no human ever reads one, and asking the dictionaries
 * to answer for them would be asking for thirty Serbian sentences nobody will ever see.
 *
 * Exempted **where a slug is written, not wherever its spelling appears** — in `actions.ts`, the
 * one file that spells the vocabulary out, and inside a `data-log` attribute. That is the scoping
 * `actions.ts` documents for itself, and getting it wrong is not theoretical: this started as a
 * blanket exemption by value, and **four of the thirty-three slugs are also real translation
 * keys** — `capture.record.stop` is the label on the stop button, `confirm.open` and
 * `archive.report.download` sit on a diary row, `company.code.issue` on a foreman's page. Exempting
 * the spelling everywhere switched this guard off for four sentences a foreman actually reads:
 * delete one of them from both dictionaries and nothing would have gone red.
 *
 * The collision itself is harmless and deliberately tolerated — a slug names the same thing the
 * button says, so of course they are spelled alike. What matters is that a slug is only ignored at
 * a site where it cannot be a translation.
 */
const NOT_KEYS = new Set<string>(ACTION_VOCABULARY);

/** The one file that writes a slug out as a string; everywhere else references `ACTIONS.x`. */
const SLUG_DECLARATION = 'actions.ts';

/** `data-log="capture.photo.add"` declares an action on a control. It is never a sentence. */
const LOG_ATTRIBUTE = /\sdata-log=(["'`])[^"'`]*\1/g;

function referencedKeys(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const { path, text } of sourceFiles()) {
    const file = basename(path);
    const declaresSlugs = file === SLUG_DECLARATION;
    for (const match of text.replace(LOG_ATTRIBUTE, ' ').matchAll(KEY_LITERAL)) {
      const key = match[1] + match[2];
      if (declaresSlugs && NOT_KEYS.has(key)) {
        continue;
      }
      found.push({ key, file });
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

  /**
   * The one sentence on the code screen that must not reassure him.
   *
   * Every other failure there can honestly end "the code is not used up": nothing was sent, or the
   * server refused it. `unreadable` is the opposite — the server answered 200, so the code **is**
   * spent and the device row **does** exist, and only this build's reading of the response failed.
   * On 2026-08-31 the founder met exactly that, was told his code was untouched, and burned a
   * second single-use code proving it was not.
   *
   * Pinned as a property of the copy rather than as an exact string, so the founder's copy pass
   * can rewrite the sentence freely and only the lie is out of bounds.
   */
  it('never tells a man his single-use code is untouched when the server has already taken it', () => {
    const untouched = [/not used up/i, /nije potrošen/i, /nije potrošena/i];

    for (const dictionary of [en, sr]) {
      const sentence = dictionary.auth.code.error.unreadable;
      expect(typeof sentence).toBe('string');
      for (const claim of untouched) {
        expect(sentence, `'auth.code.error.unreadable' claims the code survived a 200`).not.toMatch(
          claim,
        );
      }
    }

    // And the reassurance is still there where it is true — a failure before the server answered.
    expect(en.auth.code.error.offline).toMatch(/not used up/i);
    expect(sr.auth.code.error.offline).toMatch(/nije potrošen/i);
  });

  /**
   * The same guard for the one word on the profile screen that names a person's standing (F5).
   *
   * `profile-page.html` builds `profile.role.<role>` by concatenation, so the literal scan above
   * cannot see a single one of those keys. `PROFILE_ROLES` is kept complete by a `Record` the
   * compiler checks — including `unknown`, which exists precisely so that an older phone meeting a
   * newer server reads a sentence instead of a raw wire string next to a man's name.
   */
  it('can name every role the profile screen is able to show', () => {
    expect(PROFILE_ROLES.length).toBeGreaterThan(0);
    for (const role of PROFILE_ROLES) {
      expect(enKeys, `no English word for '${role}'`).toContain(`profile.role.${role}`);
      expect(srKeys, `no Serbian word for '${role}'`).toContain(`profile.role.${role}`);
    }
  });

  /**
   * The same guard for the office (F6) — **the one screen in the product that can hand out a
   * credential or take a phone away**.
   *
   * `CompanyStatus` is deliberately five failures rather than one, because the remedies differ:
   * signing in again fixes a 401 and can never fix a 403, and "there is no internet" and "the
   * server refused" send an owner to two different people. Every one of those distinctions is
   * worth nothing if the sentence behind it is missing or is the catch-all in disguise — the
   * screen would tell a man whose role forbids the action that the server is merely unwell, and
   * he would sit there pressing refresh.
   *
   * `COMPANY_REASON_KEYS` is a `Record<Exclude<CompanyStatus, 'ok'>, string>` the compiler keeps
   * complete, and `COMPANY_STATUSES` is kept complete by a `Record<CompanyStatus, true>` beside
   * the union, so adding a status fails here until both dictionaries can name it.
   */
  it('can name every way the company screen is able to fail', () => {
    expect(COMPANY_STATUSES.length).toBeGreaterThan(0);

    for (const status of COMPANY_STATUSES) {
      if (status === 'ok') {
        // "It worked" is not a reason, and the map excludes it by type.
        expect(COMPANY_REASON_KEYS).not.toHaveProperty(status);
        continue;
      }

      const key = COMPANY_REASON_KEYS[status];
      expect(enKeys, `no English sentence for '${status}'`).toContain(key);
      expect(srKeys, `no Serbian sentence for '${status}'`).toContain(key);

      // …and it is a sentence about *this* status, not the catch-all wearing a table's clothes.
      // `company.reason.unavailable` is what the template falls back to when a key resolves to
      // nothing, so a status mapped onto it is indistinguishable from a status with no mapping.
      if (status !== 'unavailable') {
        expect(key, `'${status}' falls back to the generic line`).not.toBe(
          'company.reason.unavailable',
        );
      }
    }
  });

  /**
   * The two sentences the company screen builds by hand rather than from a union, and the reason
   * they exist at all.
   *
   * Issuing a code **supersedes** the one the worker is holding. So an issue that got no verdict
   * from the server is not a failure the admin may retry — a second press would supersede a code
   * that already exists and is on its way to a man's phone. `company.code.unconfirmed` is the
   * sentence that says so, and it must not read as a plain failure or as a read that went wrong.
   */
  it('never tells an owner an unanswered issue simply failed', () => {
    for (const dictionary of [en, sr]) {
      expect(typeof dictionary.company.code.unconfirmed).toBe('string');
      expect(typeof dictionary.company.code.issueFailed).toBe('string');
      // The "we do not know" sentence has to say what to do instead of pressing again.
      expect(dictionary.company.code.unconfirmed).not.toBe(dictionary.company.code.failed);
      expect(dictionary.company.code.unconfirmed).not.toBe(dictionary.company.reason.unavailable);
    }

    expect(en.company.code.unconfirmed).toMatch(/refresh/i);
    expect(sr.company.code.unconfirmed).toMatch(/osvežite/i);
  });

  /**
   * The one sentence on this screen an owner acts on irreversibly, pinned as a property so the
   * founder's copy pass can rewrite it freely and only the omission is out of bounds.
   *
   * Under the shipped client a revoked phone's queue stops getting through until the man
   * re-activates (`DeviceEndpoints.cs` says the copy must tell him). Both halves matter: leave out
   * "his day stops being sent" and an owner revokes a phone in the middle of a shift without
   * knowing; leave out "nothing is deleted" and he does not dare revoke a handset that walked off
   * site.
   */
  it('says what revoking a phone costs, in both languages', () => {
    /*
     * **This spec asserted the opposite until 2026-09-03, and the copy it was pinning had become
     * a lie.** Both sentences promised the admin that a withdrawn phone "keeps recording" (*"On i
     * dalje snima"*), which was true of the old policy — a revoked phone kept its session and the
     * record button, and the refusal surfaced as a notice (plan §10.3, F8). By founder decision of
     * 2026-09-03 the phone signs itself out instead, so the man does **not** keep recording, and a
     * confirmation dialog that says he does is the product misinforming the one person deciding
     * whether to press it.
     *
     * The half that did not change is the half that matters most: **nothing on the phone is
     * deleted.** PROJECT.md principle 3 is untouched — a sign-out clears one `localStorage` row —
     * and that promise is pinned here in both languages, positively, alongside the claim that is
     * now forbidden.
     */
    expect(sr.company.phones.confirm.body).toMatch(/odjavljuje/i);
    expect(sr.company.phones.confirm.body).toMatch(/ne briše/i);
    expect(sr.company.phones.confirm.body).toMatch(/novim kodom/i);
    expect(sr.company.phones.confirm.body, 'he no longer keeps recording').not.toMatch(
      /i dalje snima/i,
    );

    expect(en.company.phones.confirm.body).toMatch(/signs itself out/i);
    expect(en.company.phones.confirm.body).toMatch(/nothing on the phone is deleted/i);
    expect(en.company.phones.confirm.body).toMatch(/new code/i);
    expect(en.company.phones.confirm.body, 'he no longer keeps recording').not.toMatch(
      /keeps recording/i,
    );
  });

  /**
   * The same lie, in the two places on the platform surface that told it (2026-09-03).
   *
   * Suspending a company produces the identical 401 on every one of its foremen's phones — the
   * server joins `company.suspended_at` on each request — so those phones now sign themselves out
   * too. Two consequences the founder has to be told before he presses it: they stop recording,
   * and **resuming the company is not enough**, because each phone has to be joined again with a
   * new code. The old copy promised the opposite of both.
   */
  it('says what suspending a customer costs, and that resuming does not undo it by itself', () => {
    for (const sentence of [
      sr.platform.companies.about.body,
      sr.platform.companies.confirm.suspend,
    ]) {
      expect(sentence).toMatch(/odjavljuju/i);
      expect(sentence).toMatch(/novim kodom/i);
      expect(sentence, 'his foremen no longer keep recording').not.toMatch(/i dalje/i);
    }
    expect(sr.platform.companies.confirm.resume).toMatch(/novim kodom/i);

    for (const sentence of [
      en.platform.companies.about.body,
      en.platform.companies.confirm.suspend,
    ]) {
      expect(sentence).toMatch(/sign themselves out/i);
      expect(sentence).toMatch(/new code/i);
      expect(sentence, 'his foremen no longer keep recording').not.toMatch(/can still record/i);
      expect(sentence, 'his foremen no longer keep recording').not.toMatch(/keep recording/i);
    }
    expect(en.platform.companies.confirm.resume).toMatch(/new code/i);
  });

  /**
   * The log screen's two closed sets, both built by concatenation (D5).
   *
   * `logs-page.html` writes `t('logs.range.' + option)` and `LogsPage.levelWord` builds
   * `logs.level.<lowercase>`, so the literal scan above cannot see one of those keys. The levels
   * are the sharper half: they are **wire values** — `Warning`, `Error` — and a missing Serbian
   * word would put a raw English level on a chip beside `Greška`, on the one screen whose job is
   * to be read quickly.
   */
  it('can name every level and every period the log screen offers', () => {
    expect(LOG_LEVELS.length).toBe(6);
    for (const level of LOG_LEVELS) {
      const key = `logs.level.${level.toLowerCase()}`;
      expect(enKeys, `no English word for '${level}'`).toContain(key);
      expect(srKeys, `no Serbian word for '${level}'`).toContain(key);
    }

    expect(LOG_RANGES.length).toBeGreaterThan(0);
    for (const range of LOG_RANGES) {
      expect(enKeys).toContain(`logs.range.${range}`);
      expect(srKeys).toContain(`logs.range.${range}`);
    }
  });

  /**
   * **The log screen may not claim a total, and now it has no sentence in which to.**
   *
   * Every other table in the product prints "showing 3 of 12" because it holds all twelve. This
   * screen holds one keyset page of a stream and cannot know a total — so a count that read like
   * one would be the same lie as a quietly filtered directory, on the screen an owner opens
   * precisely because he does not trust what he is being told.
   *
   * It used to be guarded by reading `logs.count.more` / `logs.count.all` and checking neither said
   * "of {{". Those keys are **gone** (founder, 2026-09-02: *"remove the header text that is above
   * the columns"*), and a guard whose subject has been deleted is a guard that passes for ever
   * while checking nothing. So the property is pinned the other way round: the shared count
   * sentences all three *other* tables use are named, and the log screen's template is scanned to
   * prove it reaches for none of them. It is the class that is forbidden, not two spellings of it —
   * which also catches the likelier mistake, somebody adding a count strip here out of habit
   * because the other three have one.
   */
  it('never lets the log screen claim a total it cannot know', () => {
    const template = readFileSync(
      join(process.cwd(), 'src', 'app', 'features', 'platform', 'logs-page.html'),
      'utf8',
    );

    // Named from the dictionary rather than typed here, so renaming one renames it in the guard.
    const fractions = leafKeys(en.table.page, 'table.page').concat('table.filter.showing');
    expect(fractions).toContain('table.page.range');
    expect(fractions.length).toBeGreaterThan(2);

    for (const key of fractions) {
      expect(template, `${key} says "of N" and this screen has no N`).not.toContain(key);
    }

    // …and the sentences themselves really are the "of N" shape, or the scan above proves nothing.
    for (const dictionary of [en, sr]) {
      expect(read(dictionary, 'table.page.range')).toMatch(/\{\{\s*total\s*\}\}/);
    }
  });

  /**
   * The exemption above, kept honest — **by scope, not by spelling.**
   *
   * Several slugs are also real keys, because a slug names the thing the button says. The rule
   * that makes that safe is that a slug is ignored only in `actions.ts` and in a `data-log`
   * attribute. This walks the collisions and insists the scan still sees each of them somewhere
   * else: if the exemption ever widens back out to matching by value, these keys drop out of the
   * scan silently and the sentences behind them stop being checked at all.
   */
  it('still checks the keys that happen to be spelled like an action slug', () => {
    expect(ACTION_VOCABULARY.length).toBeGreaterThan(20);

    const collisions = ACTION_VOCABULARY.filter((slug) => resolves(en, slug) || resolves(sr, slug));
    // A guard on the guard: if nothing collides any more this spec proves nothing, and the
    // scoping it defends should be re-read rather than left standing on an empty set.
    expect(collisions.length).toBeGreaterThan(0);

    const scanned = new Set(
      referencedKeys()
        .filter(({ file }) => file !== SLUG_DECLARATION)
        .map(({ key }) => key),
    );
    const referenced = collisions.filter((slug) =>
      [...scanned].some((key) => key === slug || key.startsWith(`${slug}.`)),
    );
    expect(referenced.length, 'no colliding slug is checked as a key any more').toBeGreaterThan(0);
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
