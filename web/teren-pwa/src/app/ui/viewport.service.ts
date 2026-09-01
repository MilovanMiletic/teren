import { DestroyRef, Injectable, WritableSignal, inject, signal } from '@angular/core';

/**
 * The two token breakpoints (`--bp-medium` 768, `--bp-expanded` 1024) as signals.
 *
 * Layout is CSS's job in this app and almost every screen keeps it there — `.pane` is
 * `display: contents` until 1024 and the app header hides itself below 768, so the compact layout
 * the founder approved is untouched by anything a wide screen does.
 *
 * Two screens need more than that, because the device class changes **what is rendered** rather
 * than how it is arranged:
 *
 * - The archive at expanded is a two-pane master–detail. On a phone those are two screens, and
 *   rendering the detail behind a hidden list would mean minting object URLs for photos nobody is
 *   looking at and holding two sets of live queries open on a device with a battery.
 * - `/company` from medium up is a **`<table>`**, and below it a list of tappable rows. That is not
 *   a restyling of one markup: a table whose cells are forced to `display: block` loses its table
 *   role in every browser, so a phone would get the accessibility of a list with the markup of a
 *   table and neither would be honest. Two renderings, one at a time, decided here.
 *
 * The literals are repeated from `styles.css` because media queries cannot read custom properties;
 * `--bp-medium` and `--bp-expanded` remain the documented constants and nothing else may invent a
 * breakpoint.
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly destroyRef = inject(DestroyRef);

  private readonly mediumSignal = signal(false);
  private readonly expandedSignal = signal(false);

  /** True at ≥768: a tablet or a desktop, where a table is legible and a row list is a waste. */
  readonly atLeastMedium = this.mediumSignal.asReadonly();

  /** True at ≥1024: the desktop application layout, not a phone column on a big screen. */
  readonly expanded = this.expandedSignal.asReadonly();

  constructor() {
    // Guarded rather than assumed: a service worker context and older test environments have no
    // `matchMedia`, and a layout signal is not worth a boot failure. Compact is the safe default —
    // it is the layout that works at every width.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    this.track('(min-width: 768px)', this.mediumSignal);
    this.track('(min-width: 1024px)', this.expandedSignal);
  }

  private track(query: string, target: WritableSignal<boolean>): void {
    const media = window.matchMedia(query);
    target.set(media.matches);

    // Safari below 14 only has the deprecated `addListener`. Reading the initial value already
    // worked above; missing the change event just means the layout settles on the next
    // navigation, which is a far smaller defect than throwing during bootstrap.
    if (typeof media.addEventListener !== 'function') {
      return;
    }

    const onChange = (event: MediaQueryListEvent) => target.set(event.matches);
    media.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() => media.removeEventListener('change', onChange));
  }
}
