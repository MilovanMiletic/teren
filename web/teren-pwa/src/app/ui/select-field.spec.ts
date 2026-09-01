import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SelectField, SelectOption } from './select-field';

const CUSTOMERS: SelectOption[] = [
  { id: 'c1', name: 'Vodoinstal Petrović d.o.o.' },
  { id: 'c2', name: 'Elektro Nikolić d.o.o.' },
  { id: 'c3', name: 'Gradnja Marković d.o.o.' },
];

describe('SelectField', () => {
  let fixture: ComponentFixture<SelectField>;
  let element: HTMLElement;

  function render(options: SelectOption[] = CUSTOMERS, value = ''): void {
    // Reset first, so a test may render twice — comparing a placeholder against a chosen value,
    // or two instances against each other — without configuring the same TestBed a second time.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [SelectField] });
    fixture = TestBed.createComponent(SelectField);
    fixture.componentRef.setInput('label', 'FIRMA');
    fixture.componentRef.setInput('placeholder', 'Izaberite firmu…');
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
  }

  function trigger(): HTMLButtonElement {
    return element.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  }

  function list(): HTMLElement | null {
    return element.querySelector<HTMLElement>('[role="listbox"]');
  }

  function options(): HTMLElement[] {
    return Array.from(element.querySelectorAll<HTMLElement>('[role="option"]'));
  }

  function open(): void {
    trigger().click();
    fixture.detectChanges();
  }

  /** A real key event on the open list, so `stopPropagation` and `preventDefault` are observable. */
  function press(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (list() ?? trigger()).dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('says the placeholder until something is chosen, then says the choice', () => {
    render();
    expect(trigger().textContent).toContain('Izaberite firmu…');

    render(CUSTOMERS, 'c2');
    expect(trigger().textContent).toContain('Elektro Nikolić d.o.o.');
  });

  it('opens and closes on the trigger, and says which it is', () => {
    render();
    expect(list()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    open();
    expect(list()).not.toBeNull();
    expect(options()).toHaveLength(3);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    trigger().click();
    fixture.detectChanges();
    expect(list()).toBeNull();
  });

  it('emits the chosen id and closes', () => {
    render();
    const chosen: string[] = [];
    fixture.componentInstance.changed.subscribe((id) => chosen.push(id));

    open();
    options()[1].click();
    fixture.detectChanges();

    expect(chosen).toEqual(['c2']);
    expect(list(), 'the list stayed open over the choice it had just taken').toBeNull();
  });

  /**
   * The dialog-safety property, and the reason `Escape` is not handled on the document.
   *
   * This control's only caller today sits inside `app-modal-sheet`, which closes on Escape. A
   * document-level handler here would take the dialog down with the dropdown on one keypress —
   * everything typed into the form gone because he wanted to close a list. So the listbox stops
   * the event, and this asserts the stopping rather than the closing: a handler that closed the
   * list and let the key through would pass every other spec in this file.
   */
  it('keeps Escape to itself, so closing the list does not close the dialog around it', () => {
    render();
    const reachedDocument = vi.fn();
    document.addEventListener('keydown', reachedDocument);

    open();
    const event = press('Escape');

    expect(list(), 'Escape did not close the list').toBeNull();
    expect(
      reachedDocument,
      'Escape reached the document, which is where the dialog is listening',
    ).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);

    document.removeEventListener('keydown', reachedDocument);
  });

  it('walks the list with the arrows and commits on Enter', () => {
    render();
    const chosen: string[] = [];
    fixture.componentInstance.changed.subscribe((id) => chosen.push(id));

    open();
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');

    expect(chosen).toEqual(['c3']);
  });

  it('jumps to the ends with Home and End, and stops at them', () => {
    render();
    const chosen: string[] = [];
    fixture.componentInstance.changed.subscribe((id) => chosen.push(id));

    open();
    press('End');
    // Past the end is the end, not a wrap: a list that wraps sends a founder who held the key
    // down back to the top without him noticing he passed the one he wanted.
    press('ArrowDown');
    press('Enter');
    expect(chosen).toEqual(['c3']);

    open();
    press('Home');
    press('ArrowUp');
    press('Enter');
    expect(chosen).toEqual(['c3', 'c1']);
  });

  /**
   * Reopening lands on what is already chosen.
   *
   * Not decoration: a founder who reopens the list is usually checking what he picked, and one
   * press of Down from there should move to the *next* customer rather than to the second one.
   */
  it('opens with the highlight on the current choice', () => {
    render(CUSTOMERS, 'c3');
    open();

    expect(list()?.getAttribute('aria-activedescendant')).toBe(options()[2].id);
    expect(options()[2].className).toContain('option--active');
  });

  it('marks the chosen option to a screen reader, not just to the eye', () => {
    render(CUSTOMERS, 'c2');
    open();

    expect(options().map((option) => option.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  /**
   * An empty list is a dead control, so it says so rather than opening on nothing.
   *
   * The screen that uses this puts a sentence underneath explaining *which* kind of empty it is —
   * no customers yet, or the list could not be read — and those are two different problems.
   */
  it('will not open when there is nothing to choose from', () => {
    render([]);

    expect(trigger().disabled).toBe(true);

    trigger().click();
    fixture.detectChanges();
    expect(list()).toBeNull();
  });

  /**
   * Two of these on one screen must not share ARIA ids.
   *
   * `aria-controls`, `aria-labelledby` and `aria-activedescendant` are all id references: if two
   * instances agreed on them, a screen reader would announce one control's options as the other's,
   * and the bug would be invisible to everyone who can see the screen.
   */
  it('keeps its ARIA wiring to itself when there are two on a screen', () => {
    render();
    const first = trigger().getAttribute('aria-controls');

    render();
    const second = trigger().getAttribute('aria-controls');

    expect(first).not.toBe(second);
  });

  /**
   * The closed control has to be indistinguishable from the text fields beside it.
   *
   * It cannot simply *be* them: `ui/field.css` styles an `<input>`, this is a `<button>`, and a
   * component's inline styles cannot reach a shared sheet anyway. So the three declarations that
   * decide whether two controls read as one family are restated — and restated values drift. The
   * defect this catches is the quiet one: somebody raises `--tap-primary` to a literal in one file
   * and the dialog ends up with two field heights, which looks like nothing until you see it.
   *
   * Declared values, not computed ones: both sides here spell tokens, and comparing what is
   * written is what makes a divergence legible in the failure message.
   */
  it('wears the same height, radius and border as the fields it sits with', () => {
    const shared = readFileSync(join(__dirname, 'field.css'), 'utf8');
    const own = readFileSync(join(__dirname, 'select-field.ts'), 'utf8');

    const declarations = (source: string, selector: string): Record<string, string> => {
      const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
      const found: Record<string, string> = {};
      for (const line of block.split(';')) {
        const [property, ...rest] = line.split(':');
        if (rest.length > 0) {
          found[property.trim()] = rest.join(':').trim();
        }
      }
      return found;
    };

    const field = declarations(shared, '.field__input');
    const control = declarations(own, '.trigger');

    expect(field['min-height'], 'the shared field lost its height').toBeTruthy();

    for (const property of ['min-height', 'border', 'border-radius', 'background']) {
      expect(control[property], `.trigger and .field__input disagree about ${property}`).toBe(
        field[property],
      );
    }
  });
});
