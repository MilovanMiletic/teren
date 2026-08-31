import { Component } from '@angular/core';
import { Routes } from '@angular/router';

import { CaptureSavedPage } from '../features/capture/capture-saved-page';
import { PendingPage } from '../features/pending/pending-page';
import { entryUrlFor, routePathFor, routeUrlFor } from './route-table';

@Component({ selector: 'app-elsewhere', template: '' })
class Elsewhere {}

/**
 * The helper the other specs trust to tell them what a path is.
 *
 * Every route-coupling guard in this suite — `app.spec.ts`, `rescue.service.spec.ts`,
 * `capture-recording-page.spec.ts`, `device.guard.spec.ts` — resolves its paths through this file
 * rather than restating them. That makes it the one place where a wrong answer would be
 * *believed*: a helper that quietly returned the wrong path would turn four guards into four
 * specs that agree with each other and with nothing else, which is the exact failure F4b's defect
 * was made of.
 */
describe('routePathFor', () => {
  it('resolves a screen to its path in the real table', async () => {
    expect(await routePathFor(PendingPage)).toBe('pending');
    expect(await routeUrlFor(PendingPage)).toBe('/pending');
  });

  it('refuses to guess when two routes render the same screen', async () => {
    // An alias, or an old URL kept alive through a migration — a legitimate thing to want, and
    // exactly when returning "the first one" would hand a spec the wrong half of the answer
    // without a word. The table is synthetic because the real one must never be in this state.
    const table: Routes = [
      { path: 'pending', loadComponent: async () => PendingPage },
      { path: 'cekaju', loadComponent: async () => PendingPage },
    ];

    await expect(routePathFor(PendingPage, table)).rejects.toThrow(/2 routes/);
  });

  it('says so when no route renders the screen at all', async () => {
    await expect(routePathFor(Elsewhere)).rejects.toThrow(/No route/);
  });

  it('builds a single-entry URL from the parameterised path in the table', async () => {
    expect(await entryUrlFor(CaptureSavedPage, 'a b/c')).toBe('/entry/a%20b%2Fc');
  });

  it('refuses to build a single-entry URL for a route that takes no parameter', async () => {
    await expect(entryUrlFor(PendingPage, 'anything')).rejects.toThrow(/takes no parameter/);
  });
});
