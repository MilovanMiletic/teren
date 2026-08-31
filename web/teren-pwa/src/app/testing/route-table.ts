import { Type } from '@angular/core';
import { Routes } from '@angular/router';

import { routes } from '../app.routes';

/**
 * Look a path up in the **real** route table by the screen it renders, never by its string.
 *
 * Two things in this app are coupled to route paths with no compiler in between:
 * `capture-recording-page.ts` navigates to the saved screen by literal segment, and
 * `rescue.service.ts` parses `location.pathname` to work out which entry the foreman has open and
 * must therefore be exempt from the abandoned-draft sweep. Rename a path in `app.routes.ts` and
 * neither of them fails to build. At runtime the wildcard swallows the mismatch: the foreman is
 * redirected to Home with no error, and his open draft is quietly force-queued mid-composition.
 * That is precisely how F4b's defect shipped — every spec on both sides hardcoded its own copy of
 * the path, so both halves agreed with themselves and neither could see the break.
 *
 * The fix is to make the specs *derive* the path from the table. The key is the **component
 * class itself**, passed by reference: a spec written against this helper goes red the moment a
 * route is renamed without its consumer, which is the only compiler substitute available here.
 * Matching on `Function.name` would not do — the build renames classes (`_CaptureSavedPage`), so
 * a name-keyed lookup is a string coupling wearing a disguise.
 *
 * Resolving `loadComponent` really does run the lazy import; it does not instantiate anything.
 *
 * **Every route is resolved, not just routes up to the first hit**, because a component reachable
 * by two paths has no single answer and a helper that returned the first one would hand every
 * caller a coin flip. Two routes to one screen is a legitimate thing to want — an alias, a
 * migration window while an old URL is kept alive — and it is precisely then that a spec quietly
 * asserting against the wrong half is worth nothing. So it throws, and whoever adds the second
 * route decides what the specs should say.
 */
export async function routePathFor(
  component: Type<unknown>,
  // The real table, always, outside this file's own spec — which passes a synthetic one because
  // the duplicate-route case cannot be created in `app.routes.ts` without breaking the app.
  table: Routes = routes,
): Promise<string> {
  const paths: string[] = [];

  for (const route of table) {
    if (!route.loadComponent) {
      continue;
    }
    const loaded = (await route.loadComponent()) as Type<unknown> | { default: Type<unknown> };
    const loadedComponent = 'default' in loaded ? loaded.default : loaded;
    if (loadedComponent === component) {
      if (route.path === undefined) {
        throw new Error(`The route rendering ${component.name} has no path.`);
      }
      paths.push(route.path);
    }
  }

  if (paths.length === 0) {
    throw new Error(`No route in app.routes.ts renders ${component.name}.`);
  }
  if (paths.length > 1) {
    throw new Error(
      `${paths.length} routes in app.routes.ts render ${component.name} (${paths.join(', ')}); ` +
        'routePathFor cannot say which one a consumer means. Resolve the ambiguity in the route ' +
        'table, or look the path up by something other than the component.',
    );
  }

  return paths[0];
}

/** The absolute URL of a screen with no route parameters — `PendingPage` becomes `/pending`. */
export async function routeUrlFor(component: Type<unknown>): Promise<string> {
  return `/${await routePathFor(component)}`;
}

/**
 * The absolute URL of a single-entry screen, built from the route table's own parameterised path.
 *
 * `entry/:entryId` becomes `/entry/<id>`; rename the route to `saved/:entryId` and this returns
 * `/saved/<id>`, which is what makes a consumer still saying `entry` fail loudly.
 */
export async function entryUrlFor(component: Type<unknown>, entryId: string): Promise<string> {
  const path = await routePathFor(component);
  if (!/:[A-Za-z0-9_]+/.test(path)) {
    throw new Error(`The route rendering ${component.name} takes no parameter: ${path}`);
  }
  return `/${path.replace(/:[A-Za-z0-9_]+/, encodeURIComponent(entryId))}`;
}
