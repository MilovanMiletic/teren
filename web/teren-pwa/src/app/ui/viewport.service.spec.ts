import { TestBed } from '@angular/core/testing';

import { ViewportService } from './viewport.service';

/** One fake media query per width, with the listeners a change event has to reach. */
interface FakeQuery {
  matches: boolean;
  listeners: ((event: MediaQueryListEvent) => void)[];
  removed: number;
}

describe('ViewportService', () => {
  const real = window.matchMedia;
  let queries: Map<string, FakeQuery>;

  function install(widths: { medium: boolean; expanded: boolean }, withListeners = true): void {
    queries = new Map();
    window.matchMedia = ((query: string) => {
      const fake: FakeQuery = {
        matches: query.includes('1024') ? widths.expanded : widths.medium,
        listeners: [],
        removed: 0,
      };
      queries.set(query, fake);
      return {
        get matches() {
          return fake.matches;
        },
        media: query,
        addEventListener: withListeners
          ? (_: string, listener: (event: MediaQueryListEvent) => void) =>
              fake.listeners.push(listener)
          : undefined,
        removeEventListener: withListeners ? () => (fake.removed += 1) : undefined,
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  }

  function change(query: string, matches: boolean): void {
    const fake = queries.get(query);
    if (!fake) {
      throw new Error(`nothing asked for ${query}; asked for: ${[...queries.keys()].join(', ')}`);
    }
    fake.matches = matches;
    for (const listener of fake.listeners) {
      listener({ matches } as MediaQueryListEvent);
    }
  }

  afterEach(() => {
    window.matchMedia = real;
  });

  it('reads both token breakpoints on the first frame', () => {
    install({ medium: true, expanded: false });

    const viewport = TestBed.inject(ViewportService);

    // A tablet: a table is legible, but this is not the desktop application layout.
    expect(viewport.atLeastMedium()).toBe(true);
    expect(viewport.expanded()).toBe(false);
    expect([...queries.keys()]).toEqual(['(min-width: 768px)', '(min-width: 1024px)']);
  });

  it('follows a window being resized across either breakpoint', () => {
    install({ medium: false, expanded: false });
    const viewport = TestBed.inject(ViewportService);

    change('(min-width: 768px)', true);
    expect(viewport.atLeastMedium()).toBe(true);
    expect(viewport.expanded()).toBe(false);

    change('(min-width: 1024px)', true);
    expect(viewport.expanded()).toBe(true);

    change('(min-width: 768px)', false);
    change('(min-width: 1024px)', false);
    expect(viewport.atLeastMedium()).toBe(false);
    expect(viewport.expanded()).toBe(false);
  });

  /**
   * A service worker context and an older test environment have no `matchMedia`, and a layout
   * signal is not worth a boot failure. **Compact is the safe default** — it is the layout that
   * works at every width, and on `/company` it is the rendering that needs no table semantics.
   */
  it('falls back to compact rather than throwing when there is no matchMedia', () => {
    Reflect.deleteProperty(window, 'matchMedia');

    const viewport = TestBed.inject(ViewportService);

    expect(viewport.atLeastMedium()).toBe(false);
    expect(viewport.expanded()).toBe(false);
  });

  /** Safari below 14 has only the deprecated `addListener`; the initial read still has to work. */
  it('keeps the width it read when the browser cannot report changes', () => {
    install({ medium: true, expanded: true }, false);

    const viewport = TestBed.inject(ViewportService);

    expect(viewport.atLeastMedium()).toBe(true);
    expect(viewport.expanded()).toBe(true);
  });
});
