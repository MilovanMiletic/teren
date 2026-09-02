import { Routes } from '@angular/router';

import { routes } from '../../app.routes';
import { requiresCompanyAdmin, requiresDevice, requiresSuperAdmin } from '../session/device.guard';
import { guardedSurfaceFor } from './log-surface';

/**
 * Every path in the shipped table, resolved from the table itself.
 *
 * Nothing in this file spells a route out. That is the whole point of the function under test: a
 * rename must not silently start filing a founder's clicks under a customer's company, and a spec
 * that restated the paths would agree with itself while the app misattributed.
 */
function pathsGuardedBy(guard: unknown, table: Routes = routes): string[] {
  return table
    .filter((route) => (route.canMatch ?? []).some((candidate) => candidate === guard))
    .map((route) => `/${route.path}`);
}

/** A parameterised path with something plausible in the slot. */
function filled(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, '8f0d3a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f');
}

describe('which credential an action was performed under', () => {
  it('calls every admin-guarded route an admin surface', () => {
    const admin = [
      ...pathsGuardedBy(requiresCompanyAdmin),
      ...pathsGuardedBy(requiresSuperAdmin),
    ];
    expect(admin.length).toBeGreaterThan(3);

    for (const path of admin) {
      expect(guardedSurfaceFor(filled(path)), path).toBe('admin');
    }
  });

  /**
   * The other half, and the one that matters most: **a foreman's day may never be filed under
   * Teren staff.** A super admin has no company by construction, so a capture event sent under his
   * bearer would land with no tenant scope at all.
   */
  it('never calls a device-guarded route an admin surface', () => {
    const device = pathsGuardedBy(requiresDevice);
    expect(device.length).toBeGreaterThan(4);

    for (const path of device) {
      expect(guardedSurfaceFor(filled(path)), path).not.toBe('admin');
    }
  });

  it('leaves an ungated route undecided, for the caller to settle from the credentials it has', () => {
    // `/activate` is the one route in the table with no guard at all, by design.
    expect(guardedSurfaceFor('/activate')).toBeNull();
    expect(guardedSurfaceFor('/nothing-matches-this')).toBeNull();
  });

  it('reads the path only — a query string is not part of the decision', () => {
    const [company] = pathsGuardedBy(requiresCompanyAdmin);
    expect(guardedSurfaceFor(`${company}?next=%2Fdiary#x`)).toBe('admin');
  });

  /**
   * Angular matches a leaf route only when it consumes the whole URL, and so does this.
   *
   * A shorter route must never answer for a longer URL: `/company` and `/company/worker/:id` are
   * two routes that happen to share a guard today and are not guaranteed to tomorrow.
   */
  it('does not let a shorter route answer for a longer URL', () => {
    const table: Routes = [
      { path: 'office', canMatch: [requiresCompanyAdmin] },
      { path: 'office/thing/:id', canMatch: [requiresDevice] },
    ];
    expect(guardedSurfaceFor('/office', table)).toBe('admin');
    expect(guardedSurfaceFor('/office/thing/abc', table)).toBeNull();
  });

  /**
   * The F4b lesson, made structural.
   *
   * The obvious implementation of this function is `url.startsWith('/platform')`. Renaming the
   * route would then build clean, type-check, pass every existing spec, and start filing the
   * founder's clicks under a customer weeks later. Deriving from the table means a rename changes
   * nothing here — proven by renaming one in a synthetic table and watching the answer follow.
   */
  it('follows a rename, because it reads the guards and not the words', () => {
    const renamed: Routes = [{ path: 'kancelarija', canMatch: [requiresCompanyAdmin] }];
    expect(guardedSurfaceFor('/kancelarija', renamed)).toBe('admin');
    expect(guardedSurfaceFor('/company', renamed)).toBeNull();
  });
});
