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

  it('routes home, capture, saved, archive and pending, and sends anything else home', () => {
    expect(routes.map((route) => route.path)).toEqual([
      '',
      'snimanje',
      'unos/:entryId',
      // One archive route, not two: the open record is `?unos=<id>`, so the desktop list rail
      // survives a click instead of being torn down and rebuilt.
      'dnevnik',
      'cekaju',
      '**',
    ]);
    expect(routes.at(-1)?.redirectTo).toBe('');
  });
});
