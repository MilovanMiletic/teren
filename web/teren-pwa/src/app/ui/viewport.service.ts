import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/**
 * The expanded breakpoint (`--bp-expanded`, 1024) as a signal.
 *
 * Layout is CSS's job in this app and almost every screen keeps it there — `.pane` is
 * `display: contents` until 1024 and the app header hides itself below 768, so the compact layout
 * the founder approved is untouched by anything a wide screen does.
 *
 * The archive is the one screen where the device class changes *what is rendered*, not just how
 * it is arranged. At expanded it is a two-pane master–detail: the list on the left, the open
 * record on the right, both alive at once. On a phone those are two screens, and rendering the
 * detail behind a hidden list — or worse, the list behind the open record — would mean minting
 * object URLs for photos nobody is looking at and holding two sets of live queries open on a
 * device with a battery. So this reads the breakpoint once, in one place, and the template asks.
 *
 * The literal is repeated from `styles.css` because media queries cannot read custom properties;
 * `--bp-expanded` remains the documented constant and nothing else may invent a breakpoint.
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly expandedSignal = signal(false);

  /** True at ≥1024: the desktop application layout, not a phone column on a big screen. */
  readonly expanded = this.expandedSignal.asReadonly();

  constructor() {
    // Guarded rather than assumed: a service worker context and older test environments have no
    // `matchMedia`, and a layout signal is not worth a boot failure. Compact is the safe default —
    // it is the layout that works at every width.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia('(min-width: 1024px)');
    this.expandedSignal.set(query.matches);

    // Safari below 14 only has the deprecated `addListener`. Reading the initial value already
    // worked above; missing the change event just means the layout settles on the next
    // navigation, which is a far smaller defect than throwing during bootstrap.
    if (typeof query.addEventListener !== 'function') {
      return;
    }

    const onChange = (event: MediaQueryListEvent) => this.expandedSignal.set(event.matches);
    query.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', onChange));
  }
}
