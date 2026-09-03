import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Every call that carries this phone's bearer must report a refusal, and the one that carries no
 * bearer must not** — guarded at the source, because neither half can detect its own absence.
 *
 * ## Why a scan and not only behavioural specs
 *
 * `device-refusal.service.spec.ts` drives a 401 through all four funnels and proves the sign-out
 * happens. What it cannot prove is anything about the **fifth** funnel: the method somebody adds
 * next month for `GET /api/projects/{id}/summary`, which will compile, type-check, pass every
 * existing spec, and silently be the one path on which a revoked phone goes on believing it is
 * signed in. That is the shape of defect this repo has now shipped three times — F4b's half-renamed
 * routes, F12's 33 declared slugs with 26 of them unreachable — and the fix each time was the same:
 * walk the registry and ask whether every entry is wired, rather than asking whether the wired ones
 * are correct.
 *
 * `authHeaders()` is the registry here. It is the one private method that attaches this phone's
 * credential, so "carries the bearer" and "calls `authHeaders()`" are the same statement, and it
 * cannot be avoided by a new method that means to send the token.
 *
 * ## And the other direction, which is the more expensive mistake
 *
 * `putObject` talks to object storage with a presigned URL and **no** `Authorization` header (S3
 * rejects a signed request that carries one). A 403 from there is usually a signature past its
 * fifteen-minute TTL and says nothing whatsoever about this phone's credential — so reporting it
 * would sign a foreman out mid-upload because a URL got stale, which is both wrong and would look
 * exactly like a revocation to everyone reading the log afterwards.
 *
 * ## Prove the scan can fail before trusting it
 *
 * Remove `this.bearing(` from `get()` and the first assertion goes red naming `get`; add
 * `this.authHeaders()` to `putObject` and the third does. Both were run before this file shipped.
 */

/** The client, with comments removed — a doc comment is prose about the code, not the code. */
function clientSource(): string {
  const path = join(process.cwd(), 'src', 'app', 'core', 'api', 'teren-api.client.ts');
  return (
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Comments go first for the reason `action-wiring.spec.ts` strips them: this file's own doc
      // comments name `authHeaders`, `bearing` and `putObject` repeatedly, and a guard that fails
      // on prose about itself is a guard somebody deletes. It also keeps the brace counting below
      // honest — a `{@link}` or a sketch of code in a comment would throw the depth off.
      .replace(/\/\/[^\n]*/g, ' ')
  );
}

/**
 * The methods of the class, by name, with their bodies.
 *
 * Crude by design — a real parser is not worth it for one class — and imprecise only in the safe
 * direction: a declaration this misses drops out of the check and shows up as a failing
 * anti-vacuity assertion, rather than passing in silence.
 *
 * Brace counting over the stripped source is sound here because the only braces left are code:
 * template literals interpolate with balanced `${…}`, and no string literal in the file contains a
 * brace.
 */
function methods(): Map<string, string> {
  const source = clientSource();
  const found = new Map<string, string>();

  // A member declared at one indent inside the class: `async getMe(): Promise<…> {`,
  // `private async get<T>(path: string): Promise<T> {`, `get configured(): boolean {`.
  const declaration = /^ {2}(?:private |protected |public )?(?:async )?(?:get |set )?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\(/gm;

  for (const match of source.matchAll(declaration)) {
    const open = source.indexOf('{', match.index);
    if (open === -1) {
      continue;
    }
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') {
        depth += 1;
      } else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    found.set(match[1], source.slice(open, end + 1));
  }

  return found;
}

/** The wrapper that reports a refusal, named once so a rename is one edit. */
const WRAPPER = 'this.bearing(';

describe('TerenApiClient and the refused bearer', () => {
  const bodies = methods();

  /** Every method that attaches this phone's credential — `authHeaders` itself excluded. */
  const bearerCarrying = [...bodies]
    .filter(([name, body]) => name !== 'authHeaders' && body.includes('this.authHeaders()'))
    .map(([name]) => name)
    .sort();

  it('scans enough of the client for any of this to mean anything', () => {
    // Anti-vacuity. A changed path, a renamed class or a declaration regex that stopped matching
    // would make every assertion below pass over an empty map — which is exactly the silence this
    // file exists to break.
    expect(bodies.size).toBeGreaterThan(12);
    expect(bodies.has('authHeaders')).toBe(true);
    expect(bodies.has('putObject')).toBe(true);
    expect(bodies.has('bearing')).toBe(true);
  });

  it('routes every bearer-carrying call through the refusal wrapper', () => {
    // Four today: the two JSON funnels and the two blob downloads, which build their requests
    // themselves because `responseType: 'blob'` cannot go through `get()`.
    expect(bearerCarrying).toEqual(['downloadReport', 'fetchMedia', 'get', 'post']);

    for (const name of bearerCarrying) {
      expect(bodies.get(name), `${name}() sends the device token without reporting a refusal`)
        .toContain(WRAPPER);
    }
  });

  it('keeps the object-storage PUT out of it, in both directions', () => {
    const body = bodies.get('putObject') ?? '';
    // No bearer: a presigned request carries its signature in the query string and S3 refuses one
    // that also has an `Authorization` header.
    expect(body).not.toContain('authHeaders');
    // And no reporting: a 403 from object storage is usually an expired signature, and signing a
    // foreman out over one would be a revocation that never happened.
    expect(body).not.toContain(WRAPPER);
    expect(body).not.toContain('refusals');
  });

  it('reports the refusal from inside the wrapper, and rethrows what it was given', () => {
    // Without this the wrapper could be reduced to `return call()` and every assertion above would
    // still pass — four methods routing through a function that does nothing.
    const body = bodies.get('bearing') ?? '';
    expect(body).toContain('this.refusals.report(');
    // Rethrown unchanged: every caller's classification, retry policy and screen copy depend on
    // getting the original error, and swallowing it here would turn a failed upload into a
    // resolved promise carrying `undefined`.
    expect(body).toContain('throw error;');
  });
});
