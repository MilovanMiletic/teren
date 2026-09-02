import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { ColumnMenu } from './column-menu';
import { SortDirection } from './table-controls';

describe('ColumnMenu', () => {
  let fixture: ComponentFixture<ColumnMenu>;
  let element: HTMLElement;

  const seen = {
    toggled: 0,
    sorted: [] as SortDirection[],
    filters: [] as string[],
  };

  function render(
    inputs: {
      label?: string;
      sort?: SortDirection | null;
      kind?: 'text' | 'date' | 'state' | 'number';
      filter?: string;
      variant?: 'header' | 'pill';
    } = {},
  ): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        ColumnMenu,
        // The shipped dictionaries: a spec with its own copies would pass while the real Serbian
        // was missing the keys this component invents.
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
    });

    fixture = TestBed.createComponent(ColumnMenu);
    fixture.componentRef.setInput('label', inputs.label ?? 'Osoba');
    fixture.componentRef.setInput('sort', inputs.sort ?? null);
    fixture.componentRef.setInput('kind', inputs.kind ?? 'text');
    fixture.componentRef.setInput('filter', inputs.filter ?? '');
    fixture.componentRef.setInput('variant', inputs.variant ?? 'header');

    fixture.componentInstance.toggled.subscribe(() => (seen.toggled += 1));
    fixture.componentInstance.sorted.subscribe((d) => seen.sorted.push(d));
    fixture.componentInstance.filterChanged.subscribe((v) => seen.filters.push(v));

    element = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  function label(): HTMLButtonElement {
    return element.querySelector<HTMLButtonElement>('.sort')!;
  }

  function funnel(): HTMLButtonElement {
    return element.querySelector<HTMLButtonElement>('.more')!;
  }

  function menu(): HTMLElement | null {
    return element.querySelector<HTMLElement>('.menu');
  }

  function open(): void {
    funnel().click();
    fixture.detectChanges();
  }

  /** Let one animation frame pass, which is the loop that keeps the menu under its trigger. */
  async function frame(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    fixture.detectChanges();
  }

  /**
   * Pin the funnel's rectangle, and hand back the setter that moves it.
   *
   * jsdom lays nothing out, so every `getBoundingClientRect` is zeroes; the point of the test is
   * what the component does when that rectangle *changes*, which is a thing a browser does to it
   * rather than a thing it can be asked for.
   */
  function pinTrigger(top: number): (next: number) => void {
    let box = { top, bottom: top + 28, left: 400, right: 428, width: 28, height: 28 };
    vi.spyOn(funnel(), 'getBoundingClientRect').mockImplementation(() => box as DOMRect);
    return (next: number) => {
      box = { ...box, top: next, bottom: next + 28 };
    };
  }

  beforeEach(() => {
    seen.toggled = 0;
    seen.sorted = [];
    seen.filters = [];
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  /**
   * **One tap still sorts.** The whole point of two controls rather than one is that the gesture a
   * founder makes twenty times a day does not grow a menu in front of it.
   */
  it('sorts from the label without opening anything', () => {
    render();

    label().click();
    fixture.detectChanges();

    expect(seen.toggled).toBe(1);
    expect(menu()).toBeNull();
  });

  it('draws the arrow only on the column the list is ordered by, and turns it over', () => {
    render({ sort: null });
    expect(element.querySelector('.sort__arrow')).toBeNull();

    render({ sort: 'asc' });
    expect(element.querySelector('.sort__arrow--asc')).not.toBeNull();

    render({ sort: 'desc' });
    expect(element.querySelector('.sort__arrow')).not.toBeNull();
    expect(element.querySelector('.sort__arrow--asc')).toBeNull();
  });

  /**
   * The two directions are named in **words**, and the words differ by what the column holds:
   * "ascending" over a column of dates tells an owner nothing.
   */
  it('names both directions in the column’s own vocabulary', () => {
    render({ kind: 'date' });
    open();

    const items = [...element.querySelectorAll('.menu__item')].map((n) => n.textContent?.trim());
    expect(items).toEqual(['Prvo najstarije', 'Prvo najnovije']);

    render({ kind: 'text' });
    open();
    expect([...element.querySelectorAll('.menu__item')].map((n) => n.textContent?.trim())).toEqual([
      'Redom A → Ž',
      'Redom Ž → A',
    ]);
  });

  it('reports the direction that was chosen by name, and closes', () => {
    render();
    open();

    element.querySelectorAll<HTMLButtonElement>('.menu__item')[1].click();
    fixture.detectChanges();

    expect(seen.sorted).toEqual(['desc']);
    expect(menu()).toBeNull();
  });

  /**
   * The filter is reported per keystroke and **the menu stays open**: closing on the first
   * character would take away the box he is typing into.
   */
  it('reports every keystroke and keeps the box on screen', () => {
    render();
    open();

    const box = element.querySelector<HTMLInputElement>('.menu__input')!;
    box.value = 'jov';
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(seen.filters).toEqual(['jov']);
    expect(menu()).not.toBeNull();
  });

  /**
   * A live filter is loud on purpose. A table quietly showing three of twelve rows is the one state
   * in which a screen can make an owner believe a foreman has been removed from his company.
   */
  it('marks the column while it is filtered, and offers the way out', () => {
    render({ filter: 'jov' });

    expect(funnel().classList.contains('more--on')).toBe(true);

    open();
    const clear = element.querySelector<HTMLButtonElement>('.menu__clear')!;
    expect(clear).not.toBeNull();

    clear.click();
    fixture.detectChanges();
    expect(seen.filters).toEqual(['']);
  });

  it('has nothing to clear while nothing is filtered', () => {
    render();
    open();

    expect(element.querySelector('.menu__clear')).toBeNull();
  });

  /**
   * A disclosure, not a tooltip and not a modal: the funnel says what it controls and whether it is
   * open, and the panel is a `group` so that the app's one `role="dialog"` keeps meaning the modal
   * sheet — several specs reach for "the dialog on screen" and would otherwise find a column menu.
   */
  it('announces itself as a disclosure over a named dialog', () => {
    render({ label: 'Stanje' });

    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    expect(funnel().getAttribute('aria-label')).toBe('Kolona Stanje: redosled i filter');

    open();
    expect(funnel().getAttribute('aria-expanded')).toBe('true');
    expect(menu()?.getAttribute('role')).toBe('group');
    expect(funnel().getAttribute('aria-controls')).toBe(menu()?.id);
  });

  it('closes on a tap outside, and on Escape', () => {
    render();

    open();
    document.body.click();
    fixture.detectChanges();
    expect(menu()).toBeNull();

    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(menu()).toBeNull();
  });

  /**
   * **The review's second gating finding, pinned.**
   *
   * The menu is `position: fixed` and was placed once, at open. One keystroke into the filter box
   * makes the "showing 1 of 12" strip appear above the table, which moves every column head down
   * 61 px — and the menu stayed where it was, over the header cell and the first result row. On a
   * phone it covered the very control bar it hangs from. Anything that moves the trigger does this:
   * the strip appearing, the owner's row leaving the list, a scroll, a soft keyboard, a rotation.
   * So it follows, once a frame, while it is open.
   */
  it('follows its trigger when the page shifts under it', async () => {
    render();
    const move = pinTrigger(300);

    open();
    expect(menu()!.style.top).toBe('336px');

    // The filter strip appears above the table and pushes the whole header row down.
    move(361);
    await frame();

    expect(menu()!.style.top).toBe('397px');
  });

  /** …and it stops following the moment it is shut, rather than measuring for ever. */
  it('stops measuring when it closes', async () => {
    render();
    const move = pinTrigger(300);

    open();
    const box = funnel().getBoundingClientRect as unknown as { mock: { calls: unknown[] } };
    document.body.click();
    fixture.detectChanges();

    move(500);
    await frame();
    const after = box.mock.calls.length;
    await frame();

    expect(box.mock.calls.length).toBe(after);
  });

  /**
   * Two of these on one screen — and there are six on `/company` — must not both claim the same
   * `aria-controls` target, or a screen reader follows the wrong one.
   */
  it('gives each instance an id of its own', () => {
    render();
    open();
    const first = menu()!.id;

    render();
    open();
    expect(menu()!.id).not.toBe(first);
  });

  /**
   * The phone's pill keeps the class names and the `aria-pressed` the row lists have used since the
   * office rework — it is one control with two looks, not two controls.
   */
  it('travels as a pill below 768, still saying which column is live', () => {
    render({ variant: 'pill', sort: 'asc' });

    expect(label().classList.contains('sort-pill')).toBe(true);
    expect(label().classList.contains('sort-pill--on')).toBe(true);
    expect(label().getAttribute('aria-pressed')).toBe('true');

    render({ variant: 'pill', sort: null });
    expect(label().getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * The header variant carries no `aria-pressed` at all: the `<th>` around it already says
   * `aria-sort`, and a button that is "pressed" as well would have a screen reader announce the
   * same fact twice in two vocabularies.
   */
  it('leaves the pressed state to the pill, and the sort state to the header cell', () => {
    render({ variant: 'header', sort: 'asc' });

    expect(label().hasAttribute('aria-pressed')).toBe(false);
  });
});
