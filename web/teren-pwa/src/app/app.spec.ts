import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('creates the shell', () => {
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });

  it('routes home, capture, saved, confirm, archive, pending and identity, and sends anything else home', () => {
    expect(routes.map((route) => route.path)).toEqual([
      '',
      'snimanje',
      'unos/:entryId',
      // The confirmation gate is a path segment, not a query parameter: it is a single-entry
      // screen with a form in it, so back means "leave this entry" and a reload returns to it.
      'potvrda/:entryId',
      // One archive route, not two: the open record is `?unos=<id>`, so the desktop list rail
      // survives a click instead of being torn down and rebuilt.
      'dnevnik',
      'cekaju',
      // F3. English by founder decision; the six Serbian paths above follow at F4b, in one
      // increment, so the app is never half-and-half.
      'welcome',
      'activate',
      'login',
      '**',
    ]);
    expect(routes.at(-1)?.redirectTo).toBe('');
  });

  /**
   * The ordering mistake that would cost nothing at compile time and everything at runtime.
   *
   * `'**' → redirectTo: ''` re-runs matching, so any route declared after the wildcard is
   * unreachable — the address bar would show `/activate` and Home would render, which is also
   * precisely the state `rescue.service.ts` reads `location.pathname` to understand. Asserted as
   * a property of the list rather than as a position, so it keeps holding as routes are added.
   */
  it('registers every real route before the wildcard', () => {
    const wildcard = routes.findIndex((route) => route.path === '**');
    expect(wildcard).toBe(routes.length - 1);
  });
});
