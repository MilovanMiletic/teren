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

  it('routes home, capture, saved and pending, and sends anything else home', () => {
    expect(routes.map((route) => route.path)).toEqual([
      '',
      'snimanje',
      'unos/:entryId',
      'cekaju',
      '**',
    ]);
    expect(routes.at(-1)?.redirectTo).toBe('');
  });
});
