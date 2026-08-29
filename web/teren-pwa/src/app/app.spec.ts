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

  it('routes home, capture, saved, confirm, archive and pending, and sends anything else home', () => {
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
      '**',
    ]);
    expect(routes.at(-1)?.redirectTo).toBe('');
  });
});
