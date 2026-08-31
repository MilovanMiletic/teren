/**
 * Where a man was going before the app stopped him, and the rules for trusting it back.
 *
 * The gate (`device.guard.ts`) sends an un-activated phone to `/welcome` and hangs the URL it
 * interrupted on `?next=`. That value then travels through Welcome to the activation screen and
 * is finally *navigated to* once the phone is bound — so between those points it is an
 * attacker-controlled string that the app will one day hand to the router. Everything in this
 * file exists to make that safe.
 *
 * ## Why an unvalidated `next` is a real vulnerability and not a theoretical one
 *
 * `router.navigateByUrl('//evil.com')` is a navigation to `https://evil.com`, not to a path —
 * protocol-relative URLs are absolute. A link of the form
 * `https://teren.example/welcome?next=//evil.com` therefore reads as a Teren link, opens Teren,
 * and lands the foreman on someone else's copy of the join screen, which is the ideal place to
 * harvest a username and a single-use code. That is the classic open redirect, and the login
 * surface is precisely where it is worth something.
 *
 * The rule is deliberately a whitelist of shape rather than a blacklist of hosts: exactly one
 * leading slash, no scheme, no backslash, nothing a URL parser could read as an authority.
 */

/** The query parameter, named once. */
export const RETURN_URL_PARAM = 'next';

/**
 * The paths a return URL may never point at.
 *
 * Without this, `/welcome?next=/login` sends an activated worker from Welcome to Login, whose
 * guard sends him back to Welcome, which honours `next` again — a loop with no exit, on the two
 * screens a man reaches when something has already gone wrong. `app.routes.spec.ts` pins this
 * list against the real route table, so a fourth auth screen cannot be added without joining it.
 */
export const AUTH_ROUTE_PATHS: readonly string[] = ['welcome', 'activate', 'login'];

/**
 * The return URL, if it is one this app may navigate to, otherwise `null`.
 *
 * Callers are expected to write `safeReturnUrl(raw) ?? '/'`: there is always a destination, and
 * when the parameter cannot be trusted the destination is the record button. Rejecting is never
 * an error a foreman has to read about.
 */
export function safeReturnUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.trim();

  // Exactly one leading slash. `https://evil.com` and `evil.com` fail the first test; `//evil.com`
  // — the protocol-relative form the router treats as another origin — fails the second.
  if (!value.startsWith('/') || value.startsWith('//')) {
    return null;
  }
  if (value.includes('://')) {
    return null;
  }
  // `/\evil.com`: several browsers normalise a backslash to a slash while parsing, which turns
  // this back into the protocol-relative case after the check above has already passed it.
  if (value.includes('\\')) {
    return null;
  }
  // Control characters, including the newline and tab that URL parsers strip before resolving —
  // `/\n/evil.com` is another way to spell the same attack.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }

  // Home is not a destination worth remembering: it is where every caller falls back to anyway,
  // and `?next=/` on the welcome screen is noise in front of a man who is already lost.
  if (value === '/') {
    return null;
  }

  const firstSegment = value.slice(1).split(/[/?#]/, 1)[0].toLowerCase();
  if (AUTH_ROUTE_PATHS.includes(firstSegment)) {
    return null;
  }

  return value;
}
