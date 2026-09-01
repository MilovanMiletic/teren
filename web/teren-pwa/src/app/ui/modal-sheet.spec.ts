import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { InfoPopover } from './info-popover';
import { ModalSheet } from './modal-sheet';

/**
 * The two shared pieces of chrome the office rework introduced, tested where they live rather than
 * only through the screens that use them.
 *
 * Both screens need both behaviours, and everything here — the focus trap, the return of focus, the
 * scroll lock, the hover gate — is the kind of code that rots quietly in one of two copies. One
 * implementation, one spec.
 */
@Component({
  imports: [ModalSheet, InfoPopover],
  template: `
    <button type="button" id="opener" (click)="open.set(true)">open</button>

    @if (open()) {
      <app-modal-sheet heading="Novi poslovođa" (close)="open.set(false)">
        <input id="first" type="text" />
        <button type="button" id="last">Dodaj</button>
        <button type="button" id="disabled" disabled>Nedostupno</button>
      </app-modal-sheet>
    }

    <app-info-popover heading="Kako kodovi rade" body="Kod važi jednom i traje sedam dana." />
  `,
})
class Host {
  readonly open = signal(false);
}

describe('the office chrome', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let element: HTMLElement;
  const realMatchMedia = window.matchMedia;

  /** A pointer, or not: the hover path is gated on it and the gate is half the behaviour. */
  function pointer(fine: boolean): void {
    window.matchMedia = ((query: string) =>
      ({
        matches: fine && query.includes('hover'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  function render(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        Host,
        TranslocoTestingModule.forRoot({
          langs: { sr, en },
          translocoConfig: { availableLangs: ['sr', 'en'], defaultLang: 'sr' },
          preloadLangs: true,
        }),
      ],
    });
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function key(name: string, shift = false): void {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true }),
    );
  }

  beforeEach(() => {
    pointer(false);
    document.body.style.overflow = '';
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    document.body.style.overflow = '';
  });

  describe('ModalSheet', () => {
    async function open(): Promise<void> {
      render();
      element.querySelector<HTMLButtonElement>('#opener')?.focus();
      element.querySelector<HTMLButtonElement>('#opener')?.click();
      await settle();
    }

    it('is a labelled modal dialog', async () => {
      await open();

      const dialog = element.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.getAttribute('aria-label')).toBe('Novi poslovođa');
      // Its own heading, and a close control with a translated name.
      expect(dialog?.querySelector('.modal__title')?.textContent).toBe('Novi poslovođa');
      expect(dialog?.querySelector('.modal__close')?.getAttribute('aria-label')).toBe('Zatvori');
    });

    it('moves focus to the first field, not to the close button', async () => {
      await open();

      // A dialog that exists to be typed into must not land a keyboard user on "close" and make him
      // Tab past the exit to reach the work.
      expect(document.activeElement?.id).toBe('first');
    });

    /**
     * **The return of focus.** Without it a keyboard user who closes this lands at the top of the
     * document and has to walk the whole page back to where he was.
     */
    it('hands focus back to the button that opened it', async () => {
      await open();

      key('Escape');
      await settle();

      expect(element.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement?.id).toBe('opener');
    });

    it('traps Tab inside itself, both ways', async () => {
      await open();

      const close = element.querySelector<HTMLElement>('.modal__close');
      const last = element.querySelector<HTMLElement>('#last');

      last?.focus();
      key('Tab');
      await settle();
      // Round to the *first* control in the dialog — which is the close button, since it is first in
      // DOM order — rather than out into the page behind, which the reader cannot see is covered.
      // (Focus on *open* deliberately skips it in favour of the field; the cycle does not.)
      expect(document.activeElement).toBe(close);

      close?.focus();
      key('Tab', true);
      await settle();
      expect(document.activeElement?.id).toBe('last');

      // …and the disabled button is not part of the cycle at all.
      element.querySelector<HTMLElement>('#last')?.focus();
      key('Tab');
      await settle();
      expect(document.activeElement?.id).not.toBe('disabled');
    });

    it('closes on Escape and on the backdrop, and not on a click inside itself', async () => {
      await open();
      element.querySelector<HTMLElement>('.modal__panel')?.click();
      await settle();
      expect(element.querySelector('[role="dialog"]')).not.toBeNull();

      element.querySelector<HTMLElement>('.modal')?.click();
      await settle();
      expect(element.querySelector('[role="dialog"]')).toBeNull();
    });

    it('locks the page behind it and restores what was there before', async () => {
      document.body.style.overflow = 'scroll';
      await open();
      expect(document.body.style.overflow).toBe('hidden');

      key('Escape');
      await settle();

      // Restored to the previous value, never to a hardcoded one: `styles.css` owns the body's
      // overflow and this component may not quietly take it over.
      expect(document.body.style.overflow).toBe('scroll');
    });
  });

  describe('InfoPopover', () => {
    function bubble(): HTMLElement | null {
      return element.querySelector('.pop');
    }

    function trigger(): HTMLButtonElement {
      return element.querySelector<HTMLButtonElement>('.info')!;
    }

    it('names itself after the explanation it holds', () => {
      render();

      expect(trigger().getAttribute('aria-label')).toBe('Kako kodovi rade');
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
    });

    it('toggles on a tap, which is the only gesture a phone has', async () => {
      render();

      trigger().click();
      await settle();
      expect(bubble()?.textContent).toContain('Kod važi jednom');
      expect(trigger().getAttribute('aria-expanded')).toBe('true');

      trigger().click();
      await settle();
      expect(bubble()).toBeNull();
    });

    /**
     * **Hover is ignored without a real pointer.** A touch browser fires a synthetic `mouseenter`
     * after a tap, and a bubble that then sticks until the next tap reads as a stuck screen.
     */
    it('ignores hover on a touch device', async () => {
      pointer(false);
      render();

      trigger().dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      await settle();

      expect(bubble()).toBeNull();
    });

    /**
     * With a mouse it opens on hover — and **a click must not close what the hover just opened**.
     * With one flag instead of two it did exactly that, and the 1280 screenshot showed a tinted
     * button and no bubble at all.
     */
    it('opens on hover with a real pointer, and a click keeps it open', async () => {
      pointer(true);
      render();
      const host = element.querySelector('app-info-popover')!;

      host.dispatchEvent(new MouseEvent('mouseenter'));
      await settle();
      expect(bubble()).not.toBeNull();

      trigger().click();
      await settle();
      expect(bubble()).not.toBeNull();

      // Pinned by the click, so it survives the pointer leaving.
      host.dispatchEvent(new MouseEvent('mouseleave'));
      await settle();
      expect(bubble()).not.toBeNull();

      key('Escape');
      await settle();
      expect(bubble()).toBeNull();
    });

    it('closes on a click anywhere outside it', async () => {
      render();
      trigger().click();
      await settle();

      element.querySelector<HTMLElement>('#opener')?.click();
      await settle();

      expect(bubble()).toBeNull();
    });
  });
});
