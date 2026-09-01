import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The split-screen seam, which is an agreement between two rules that nothing else enforces.
 *
 * From 1024 up, `.screen::before` paints the left **half of the window** and `.auth__body` splits
 * its columns with a grid. Those two only line up because the grid is `1fr 1fr`: `.column` is
 * centred with equal gutters, so its content box shares the window's midpoint, and equal fractions
 * therefore meet exactly where the paint stops.
 *
 * Change either half and nothing fails — the page still renders, still passes every other spec,
 * and the explanation simply straddles the seam or floats short of it. The grid was `7fr 5fr`
 * until 2026-09-01 and the comment arguing for that ratio was a good one, which is precisely why
 * somebody may restore it. This is the note that answers back.
 */
describe('the auth split screen', () => {
  /*
   * Comments stripped, and not as tidiness: the note beside `.screen::before` explains the
   * `100vw` trap by *naming* `100vw`, so the scan below found the warning and failed on it. A
   * guard that cannot survive being documented is a guard somebody deletes.
   */
  const css = readFileSync(join(__dirname, 'auth-layout.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('splits its columns where it stops painting', () => {
    expect(
      css,
      'the panel no longer ends at the halfway line — the grid below assumes it does',
    ).toContain('inset: 0 50% 0 0');

    expect(
      css,
      'the body grid is no longer equal fractions, so its columns no longer meet the painted edge',
    ).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)');
  });

  /**
   * The full-bleed trap, refused by name.
   *
   * `width: 100vw` measures the viewport **including** the scrollbar, so the usual bleed trick
   * overhangs by 15–17 px wherever one is shown. `styles.css` sets `overflow-x: hidden` on the
   * body, which means that overhang never scrolls and is therefore never noticed — it just
   * silently moves the seam off the grid. The pseudo-element on `.screen` needs no viewport unit
   * at all, and this keeps the shortcut out.
   */
  it('measures the window without viewport units, which would include the scrollbar', () => {
    expect(css, 'a viewport unit crept into the auth layout — see the note on .screen::before').not.toMatch(
      /\d+vw/,
    );
  });
});
