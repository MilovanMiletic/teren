import { CanMatchFn, Route, Routes } from '@angular/router';

import { routes } from '../../app.routes';
import { requiresCompanyAdmin, requiresSuperAdmin } from '../session/device.guard';

/**
 * Which credential an action was performed under.
 *
 * Not decoration: the server files a client event under **the caller's own scope** — `company_id`
 * comes from the bearer and never from the body — so choosing the wrong one does not merely
 * mislabel a row, it puts it in the wrong company.
 */
export type LogSurface = 'device' | 'admin';

/**
 * Which credential the route an action happened on is guarded by.
 *
 * ## Why this is derived from the guards and not from a list of paths
 *
 * The obvious implementation is `url.startsWith('/platform') || url.startsWith('/company')`. It is
 * also the F4b defect waiting to happen a third time: **a route rename is producer-side only**, it
 * builds clean, it type-checks, and the first symptom is a founder's clicks quietly filed under a
 * customer's company weeks later. So the question is asked of the shipped route table itself — the
 * guards are imported by reference, exactly as `route-table.ts` keys on component classes rather
 * than on their names, and renaming `company` to `kancelarija` changes nothing here because
 * nothing here spells it.
 *
 * ## The trap this exists to avoid
 *
 * The founder's browser is the demo phone **and** the platform console at once — it holds a device
 * session and an admin session simultaneously. `TerenApiClient` sends the device token and
 * `PlatformGateway` sends the admin one, and the two are kept apart on purpose; a client that
 * chose per call is how `/company/profile` came to describe Zoran to Petar. A logger that picked
 * "whichever token exists" would repeat that mistake at scale: on that one browser it would file
 * either every foreman's capture under Teren staff (who have **no company at all**, so the rows
 * would lose their tenant scope entirely) or every staff action inside a customer's company, which
 * is worse — Teren's own activity, filed as if it were the customer's.
 *
 * ## What happens on a route that demands nothing
 *
 * `/welcome`, `/activate`, `/login` and `/set-password` are ungated by design. Those get the
 * **device** credential when this phone has one, because on the device this product is built
 * around that answer is always right, and an admin session otherwise. The cost is stated rather
 * than hidden: on the founder's dual-session browser a `session.login` is filed under the demo
 * device rather than under the account he is signing into. Either answer is defensible there and
 * this one is never wrong on a phone.
 */
const ADMIN_GUARDS: ReadonlySet<CanMatchFn> = new Set<CanMatchFn>([
  requiresCompanyAdmin,
  requiresSuperAdmin,
]);

/**
 * The surface a URL belongs to, or `null` when the route it lands on is guarded by nothing.
 *
 * `null` rather than a default, so the caller decides what an ungated route means with the
 * credentials it can actually see — which is a different question and does not belong in a pure
 * function over the route table.
 */
export function guardedSurfaceFor(url: string, table: Routes = routes): LogSurface | null {
  const path = url.split('#')[0].split('?')[0];
  const segments = path.split('/').filter((segment) => segment !== '');

  for (const route of table) {
    if (route.path === undefined || route.path === '**') {
      continue;
    }
    if (!matches(route, segments)) {
      continue;
    }
    const guards = route.canMatch ?? [];
    return guards.some((guard) => ADMIN_GUARDS.has(guard as CanMatchFn)) ? 'admin' : null;
  }

  return null;
}

/**
 * Whether a route's path consumes exactly these segments.
 *
 * Deliberately strict about length. Angular matches a leaf route only when it consumes the whole
 * URL, so `company` must not answer for `company/worker/abc` — which is a different route with,
 * as it happens, the same guard today and no guarantee of it tomorrow.
 */
function matches(route: Route, segments: readonly string[]): boolean {
  const parts = (route.path ?? '').split('/').filter((part) => part !== '');
  if (parts.length !== segments.length) {
    return false;
  }
  return parts.every((part, index) => part.startsWith(':') || part === segments[index]);
}
