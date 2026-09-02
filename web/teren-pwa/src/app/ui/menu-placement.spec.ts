import { placeMenu } from './menu-placement';

/** A trigger's rectangle, the way `getBoundingClientRect` hands one over. */
function trigger(left: number, top: number, size = 28) {
  return { left, top, right: left + size, bottom: top + size };
}

const DESKTOP = { width: 1280, height: 900 };
/** A 390 px phone with the browser's own chrome taken off the top and bottom. */
const PHONE = { width: 390, height: 660 };

describe('placeMenu', () => {
  it('hangs under the trigger, from its right edge, on a real pointer device', () => {
    const place = placeMenu(trigger(400, 300), 260, DESKTOP);

    expect(place.top).toBe(336);
    expect(place.width).toBe(240);
    // Right edge of the trigger (428) minus the panel's width: it opens leftwards, into the page.
    expect(place.left).toBe(188);
  });

  /**
   * The control on the last column of a full-width table. Anchored to its right edge and *not*
   * clamped, a 240 px panel would hang past the window and take the page's own horizontal scrollbar
   * with it — which is a defect at any width in this product.
   */
  it('never opens past the right edge, nor past the left one', () => {
    expect(placeMenu(trigger(1260, 300), 260, DESKTOP).left).toBe(1024);
    expect(placeMenu(trigger(4, 300), 260, DESKTOP).left).toBe(16);
  });

  /** Below 768 a 240 px card hanging off a control at x=300 has nowhere to go, so it spans. */
  it('spans the gutters on a phone, whichever control opened it', () => {
    const first = placeMenu(trigger(24, 300), 260, PHONE);
    const last = placeMenu(trigger(320, 300), 260, PHONE);

    expect(first).toEqual(last);
    expect(first.left).toBe(16);
    expect(first.width).toBe(358);
  });

  /**
   * **The review's first gating finding.** The pill bar sits half way down a phone list, and a
   * menu hung under it put its filter box 56 px below the fold — unreachable, because `focus()`
   * cannot scroll a fixed element into view. There is room above, so it opens upwards.
   */
  it('flips above the trigger when the room below it is not enough', () => {
    const place = placeMenu(trigger(24, 501), 235, PHONE);

    expect(place.top).toBe(258);
    expect(place.top + 235).toBeLessThan(501);
  });

  /**
   * With more room below than above, it stays below rather than flipping into the 16 px above the
   * trigger — and is then pulled up just far enough to end inside the window (600 + 44 = 644, one
   * gutter clear of 660).
   */
  it('stays under a trigger near the top, pinned inside the window', () => {
    const place = placeMenu(trigger(24, 40), 600, PHONE);

    expect(place.top).toBe(44);
    expect(place.top + 600).toBeLessThanOrEqual(PHONE.height);
  });

  /**
   * Neither side fits — a short window, or a menu grown by a "clear the filter" line. It is pinned
   * inside the viewport and the stylesheet lets it scroll within itself: a menu that cannot be
   * reached is worse than one that scrolls.
   */
  it('never places itself off the top or the bottom of the window', () => {
    const tight = { width: 390, height: 300 };

    for (const y of [0, 40, 120, 260]) {
      const place = placeMenu(trigger(24, y), 400, tight);
      expect(place.top).toBeGreaterThanOrEqual(16);
      expect(place.top).toBeLessThanOrEqual(284);
    }
  });
});
