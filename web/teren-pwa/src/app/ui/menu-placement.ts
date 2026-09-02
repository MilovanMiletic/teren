/** A rectangle in viewport coordinates — the subset of `DOMRect` this file needs. */
export interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Where a menu is painted, in viewport coordinates. */
export interface Placement {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

/** How far a floating panel keeps from the edge of the window, and from its own trigger. */
const GUTTER = 16;
const GAP = 8;

/** Below this width the panel stops hanging off its trigger and spans the gutters instead. */
const COMPACT = 768;

/** The panel's width on a real pointer device. Fixed, so nothing depends on measuring text. */
const PANEL_WIDTH = 240;

/**
 * Where a column menu hangs: **a pure function of four rectangles**, so the awkward cases can be
 * tested rather than discovered on a phone.
 *
 * The menu is `position: fixed` because every one of its ancestors is a clipping box — the table's
 * own horizontal scroller, the phone's pill bar, the card's `overflow: hidden` — and a fixed box
 * escapes all of them. The price is that its position has to be computed, and computing it wrong is
 * how a filter box ends up 56 px below the fold on a 660 px screen with no way to scroll to it
 * (found in review, 2026-09-02).
 *
 * Four rules, each answering a case that actually happened:
 *
 * - **It hangs from the right edge of its trigger**, so the control on the last column opens
 *   leftwards *into* the page rather than off the window; clamped to the gutter at both edges.
 * - **Below 768 it spans the gutters.** A 240 px panel hanging off a control at x=300 on a 390 px
 *   screen has nowhere to go, and half of it would be off the screen.
 * - **It flips above the trigger when the room below is not enough** — which on a phone is the
 *   ordinary case, because the pill bar sits half way down a list.
 * - **When neither side fits it is pinned inside the window** and scrolls within itself (the
 *   stylesheet caps its height). A menu that cannot be reached is worse than a menu that scrolls.
 */
export function placeMenu(
  trigger: Box,
  menuHeight: number,
  viewport: { width: number; height: number },
): Placement {
  const compact = viewport.width < COMPACT;
  const width = compact ? Math.max(viewport.width - 2 * GUTTER, 200) : PANEL_WIDTH;

  const left = compact
    ? GUTTER
    : clamp(trigger.right - width, GUTTER, Math.max(viewport.width - width - GUTTER, GUTTER));

  const roomBelow = viewport.height - trigger.bottom - GAP - GUTTER;
  const roomAbove = trigger.top - GAP - GUTTER;

  let top: number;
  if (menuHeight <= roomBelow || roomBelow >= roomAbove) {
    top = trigger.bottom + GAP;
  } else {
    top = trigger.top - GAP - menuHeight;
  }

  return {
    top: clamp(top, GUTTER, Math.max(viewport.height - menuHeight - GUTTER, GUTTER)),
    left,
    width,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
