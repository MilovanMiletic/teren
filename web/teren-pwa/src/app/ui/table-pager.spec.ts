import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { TablePager, pageWindow } from './table-pager';
import { ViewportService } from './viewport.service';

/**
 * The arithmetic, tested where it lives.
 *
 * jsdom lays nothing out, so the only honest way to test the geometry of a control is to keep the
 * geometry out of the control — the precedent `ui/menu-placement.ts` set on the column menu, and
 * for the same reason: the cases that matter are the ones nobody would think to click.
 */
describe('pageWindow', () => {
  it('draws every page when they all fit', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(3, 3)).toEqual([1, 2, 3]);
  });

  it('centres the run on the page being read', () => {
    expect(pageWindow(6, 12)).toEqual([4, 5, 6, 7, 8]);
  });

  /**
   * The two clamps, which are the ones that go wrong. A window centred on page 1 would start at
   * −1, and a window centred on the last page would run past the end — and the second failure is
   * the visible one: a pager that stops offering the final page.
   */
  it('slides rather than running off either end', () => {
    expect(pageWindow(1, 12)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(12, 12)).toEqual([8, 9, 10, 11, 12]);
  });

  /** No pages is no numbers — the honest answer for a stream whose end nobody knows. */
  it('draws nothing at all when the count is unknown', () => {
    expect(pageWindow(3, 0)).toEqual([]);
  });
});

/** A host, so the pager's inputs can be changed between assertions the way a screen changes them. */
@Component({
  imports: [TablePager],
  template: `<app-table-pager
    [page]="page()"
    [pageCount]="pageCount()"
    [hasNext]="hasNext()"
    (goTo)="chosen.push($event)"
  />`,
})
class Host {
  readonly page = signal(1);
  readonly pageCount = signal(0);
  readonly hasNext = signal<boolean | null>(null);
  readonly chosen: number[] = [];
}

describe('TablePager', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let element: HTMLElement;

  /** The device class decides whether numbers are drawn, so it is stubbed rather than measured. */
  let viewport = { atLeastMedium: () => true, expanded: () => true };

  async function render(medium = true): Promise<void> {
    viewport = { atLeastMedium: () => medium, expanded: () => medium };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        Host,
        // The real dictionaries: a spec shipping its own copies would pass while the shipped
        // Serbian was missing a key.
        TranslocoTestingModule.forRoot({
          langs: { sr, en },
          translocoConfig: {
            availableLangs: ['sr', 'en'],
            defaultLang: 'sr',
            reRenderOnLangChange: true,
          },
          preloadLangs: true,
        }),
      ],
      providers: [{ provide: ViewportService, useValue: viewport as unknown as ViewportService }],
    });

    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    element = fixture.nativeElement as HTMLElement;
    await settle();
  }

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function numbers(): string[] {
    return [...element.querySelectorAll('.pager__page')].map((b) => b.textContent?.trim() ?? '');
  }

  function control(label: string): HTMLButtonElement | null {
    return (
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
        candidate.getAttribute('aria-label')?.includes(label),
      ) ?? null
    );
  }

  /** One page of a known total is furniture; the control is simply not there. */
  it('draws nothing when there is one page and nothing behind it', async () => {
    await render();
    host.pageCount.set(1);
    await settle();

    expect(element.querySelector('nav')).toBeNull();
  });

  it('draws the pages, marks the one being read, and names the nav', async () => {
    await render();
    host.pageCount.set(3);
    host.page.set(2);
    await settle();

    expect(element.querySelector('nav')?.getAttribute('aria-label')).toBe(sr.table.pager.label);
    expect(numbers()).toEqual(['1', '2', '3']);

    const current = element.querySelector('[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe('2');
    expect(element.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('emits the page that was pressed', async () => {
    await render();
    host.pageCount.set(3);
    await settle();

    element.querySelectorAll<HTMLButtonElement>('.pager__page')[2].click();

    expect(host.chosen).toEqual([3]);
  });

  it('steps one page at a time, and refuses to step off either end', async () => {
    await render();
    host.pageCount.set(3);
    host.page.set(1);
    await settle();

    expect(control(sr.table.pager.previous)?.disabled).toBe(true);
    control(sr.table.pager.next)?.click();
    expect(host.chosen).toEqual([2]);

    host.page.set(3);
    await settle();
    expect(control(sr.table.pager.next)?.disabled).toBe(true);
    control(sr.table.pager.previous)?.click();
    expect(host.chosen).toEqual([2, 2]);
  });

  /**
   * **Below 768 the same control travels as a bar**, the way the column menu travels as a pill.
   * Five 44 px targets do not fit beside two arrows on a 390 px screen, and the two arrows are the
   * gesture a thumb makes anyway.
   */
  it('says the position in words on a phone instead of drawing five targets', async () => {
    await render(false);
    host.pageCount.set(5);
    host.page.set(2);
    await settle();

    expect(numbers()).toEqual([]);
    expect(element.querySelector('.pager__position')?.textContent?.trim()).toBe('2 / 5');
    expect(control(sr.table.pager.next)).not.toBeNull();
  });

  /**
   * **The honesty of `/platform/logs`, restated for the control that could most easily break it.**
   *
   * With a keyset cursor outstanding the server has said *there is more behind this* and has not
   * said how much. "Strana 3" is a fact; "3 / 7" would be an invention, and this is the one screen
   * a founder opens precisely because he does not trust what he is being told.
   */
  it('offers a next page without inventing a last one', async () => {
    await render();
    host.pageCount.set(0);
    host.page.set(3);
    host.hasNext.set(true);
    await settle();

    expect(numbers()).toEqual([]);
    expect(element.querySelector('.pager__position')?.textContent?.trim()).toBe('Strana 3');
    expect(element.textContent).not.toContain('/');
    expect(control(sr.table.pager.next)?.disabled).toBe(false);

    control(sr.table.pager.next)?.click();
    expect(host.chosen).toEqual([4]);
  });

  /** With no total and nothing behind it, the next control is the one thing that must go dead. */
  it('closes the next control when an unknown stream has run out', async () => {
    await render();
    host.pageCount.set(0);
    host.page.set(3);
    host.hasNext.set(false);
    await settle();

    expect(control(sr.table.pager.next)?.disabled).toBe(true);
    expect(control(sr.table.pager.previous)?.disabled).toBe(false);
  });
});
