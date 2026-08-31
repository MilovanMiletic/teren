import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Route } from '@angular/router';

import { routes } from '../app.routes';

/** Stands in for whatever screen a route renders. The gate is about paths, not pixels. */
@Component({
  selector: 'app-route-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class RouteStub {}

/**
 * The **real** route table — real paths, real order, real guards — with every lazy component
 * replaced by an empty one.
 *
 * The same discipline `route-table.ts` exists for, applied to the gate: a spec that restated the
 * table would prove only that the spec agrees with itself. This derives from `app.routes.ts`, so
 * a route added without a guard, a guard put on the wrong route, or an auth route moved after the
 * wildcard all show up as a failing navigation rather than as a comment nobody updated.
 *
 * Replacing `loadComponent` is not a shortcut around the lazy path — `canMatch` runs *before* the
 * chunk is fetched, which is the whole reason it is `canMatch` — it just spares the suite from
 * booting Dexie, Transloco and the recorder to answer a question about URLs. The redirect
 * wildcard has no component and passes through untouched.
 */
export function guardedRoutes(): Route[] {
  return routes.map(({ loadComponent, ...route }) =>
    loadComponent ? { ...route, component: RouteStub } : { ...route },
  );
}
