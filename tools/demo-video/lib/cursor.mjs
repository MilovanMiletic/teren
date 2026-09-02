/**
 * A visible pointer.
 *
 * **A screencast contains no cursor.** Playwright's video is a CDP screencast of the page's own
 * compositor output, so every `mouse.move` and `click` in a recording is invisible: things happen
 * and nothing explains why. This injects a dot that follows the real input events Playwright
 * dispatches, so a viewer can see the hand.
 *
 * Appended to `documentElement`, not `body`, because Angular replaces the body's children on
 * every navigation and the dot must outlive that. Installed through `addInitScript`, so it comes
 * back on each document — the title cards included.
 */
export const cursorScript = () => {
  if (window.__terenDemoCursor) return;
  window.__terenDemoCursor = true;

  const install = () => {
    if (!document.documentElement || document.getElementById('teren-demo-cursor')) return;

    const dot = document.createElement('div');
    dot.id = 'teren-demo-cursor';
    dot.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:26px',
      'height:26px',
      'margin:-13px 0 0 -13px',
      'border-radius:50%',
      'background:rgba(232,103,74,0.30)',
      'border:2px solid #C2410C',
      'box-shadow:0 3px 12px rgba(0,0,0,0.28)',
      'pointer-events:none',
      'z-index:2147483647',
      'opacity:0',
      'transition:opacity 160ms linear,transform 90ms ease-out',
      'will-change:transform',
    ].join(';');
    document.documentElement.appendChild(dot);

    let scale = 1;
    let x = -100;
    let y = -100;
    const paint = () => {
      dot.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
    };

    /**
     * It fades out when it stops moving. A dot parked on a heading for a two-second dwell reads
     * as a rendering artefact, and there is nowhere on a 390 px screen to park it that is not on
     * top of something. So it is present exactly while it is doing something.
     */
    let idle;
    const show = () => {
      dot.style.opacity = '1';
      clearTimeout(idle);
      idle = setTimeout(() => {
        dot.style.opacity = '0';
      }, 1100);
    };

    addEventListener(
      'pointermove',
      (event) => {
        x = event.clientX;
        y = event.clientY;
        show();
        paint();
      },
      { capture: true, passive: true },
    );

    // The press. Small, quick, and the only thing that says "that was a tap".
    addEventListener(
      'pointerdown',
      () => {
        scale = 0.55;
        dot.style.background = 'rgba(194,65,12,0.55)';
        paint();
      },
      { capture: true, passive: true },
    );
    addEventListener(
      'pointerup',
      () => {
        scale = 1;
        dot.style.background = 'rgba(232,103,74,0.30)';
        paint();
      },
      { capture: true, passive: true },
    );

    paint();
  };

  if (document.documentElement) install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
};
