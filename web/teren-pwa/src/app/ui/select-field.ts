import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { Icon } from './icon';

/** One choice. `id` is what the screen stores; `name` is what the founder reads. */
export interface SelectOption {
  id: string;
  name: string;
}

/**
 * A labelled dropdown that belongs to this product.
 *
 * ## Why not a `<select>`, which is what this replaces
 *
 * A native `<select>` renders its **list** with the operating system, not with the page. Styling
 * the closed control — which `ui/field.css` does, and correctly — changes nothing about what opens
 * on top of it: a square-cornered popup with a Windows-blue highlight, in the system font, sitting
 * over a screen built out of `design/tokens.md` (founder, 2026-09-01: *"use better dropdown"*).
 * There is no CSS that reaches inside it. The only way to make the open list look like the product
 * is to stop asking the platform to draw it.
 *
 * ## Why the list expands in flow instead of floating over the page
 *
 * Because of where this control actually lives. Its one caller today is inside `app-modal-sheet`,
 * whose panel is `overflow-y: auto` with a `max-height` — **an absolutely positioned popup inside
 * it is clipped at the panel's edge**, and the taller the list the more of it disappears. The
 * alternatives are a `position: fixed` popup that measures the trigger's bounding rect and
 * re-measures it on every scroll and resize, or a list that is simply part of the document. The
 * second cannot be clipped, cannot drift out of alignment, needs no measurement, and behaves the
 * same at 390 as at 1920. The dialog grows and its own scroll takes the difference.
 *
 * ## Keyboard and screen reader
 *
 * The ARIA select-only combobox pattern: the trigger is `role="combobox"` with `aria-expanded` and
 * `aria-controls`; the list is `role="listbox"`; the active option is tracked with
 * `aria-activedescendant` rather than by moving DOM focus, so focus stays on the list and the
 * arrow keys never fight the modal's focus trap.
 *
 * Down, Up, Enter and Space open it. Inside: Up/Down move, Home/End jump, Enter and Space choose,
 * Escape closes and puts focus back on the trigger, Tab closes and moves on. A click outside
 * closes it. **Escape is handled on the list rather than on the document** — this control opens
 * inside a dialog that also closes on Escape, and a document-level handler would take the whole
 * dialog down with the dropdown on one keypress.
 */
@Component({
  selector: 'app-select-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { '(document:click)': 'onDocumentClick($event)' },
  template: `
    <span class="t-label" [id]="labelId">{{ label() }}</span>

    <button
      #trigger
      type="button"
      class="trigger"
      role="combobox"
      aria-haspopup="listbox"
      [id]="triggerId"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="listId"
      [attr.aria-labelledby]="labelId + ' ' + triggerId"
      [disabled]="options().length === 0"
      (click)="toggle()"
      (keydown)="onTriggerKey($event)"
    >
      <span class="trigger__text" [class.trigger__text--empty]="chosen() === null">
        {{ chosen()?.name ?? placeholder() }}
      </span>
      <app-icon name="chevron-down" [size]="18" class="trigger__caret" />
    </button>

    @if (open()) {
      <ul
        #list
        class="list"
        role="listbox"
        tabindex="-1"
        [id]="listId"
        [attr.aria-labelledby]="labelId"
        [attr.aria-activedescendant]="activeId()"
        (keydown)="onListKey($event)"
      >
        @for (option of options(); track option.id; let i = $index) {
          <li
            class="option"
            role="option"
            [id]="optionId(i)"
            [class.option--active]="i === active()"
            [class.option--chosen]="option.id === value()"
            [attr.aria-selected]="option.id === value()"
            (click)="choose(option)"
          >
            <span class="option__name">{{ option.name }}</span>
            @if (option.id === value()) {
              <app-icon name="check" [size]="18" class="option__tick" />
            }
          </li>
        }
      </ul>
    }

    <ng-content />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    /*
     * The closed control is the field from ui/field.css, restated rather than imported: this is a
     * button, not an input, and a shared sheet cannot be reached from a component's own styles
     * anyway. If one of the two changes the other has to change with it — select-field.spec.ts
     * asserts the height, radius and border still match.
     *
     * (No backticks anywhere in this block: it is a template literal, and one of them ends the
     * string and takes every component that imports this one down with it.)
     */
    .trigger {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      min-height: var(--tap-primary);
      padding: 0 var(--space-4);
      border: 1px solid var(--color-field-line);
      border-radius: var(--radius-field);
      background: var(--color-card);
      color: var(--color-ink);
      font-family: var(--font-family);
      /* 16 px for the same reason the input has it: iOS zooms a smaller focused control. */
      font-size: 16px;
      text-align: left;
      cursor: pointer;
    }

    .trigger:disabled {
      color: var(--color-ink-3);
      cursor: default;
    }

    .trigger__text {
      flex-grow: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Nothing chosen yet reads as a placeholder, exactly as the inputs beside it do. */
    .trigger__text--empty {
      color: var(--color-ink-3);
    }

    .trigger__caret {
      flex: none;
      color: var(--color-ink-2);
      transition: transform 120ms ease;
    }

    .trigger[aria-expanded='true'] .trigger__caret {
      transform: rotate(180deg);
    }

    /*
     * The list. In flow, under the trigger — see the file comment for why it does not float.
     *
     * The cap is on the list rather than on the dialog: eight rows is a reachable scroll and a
     * shape a reader can take in, and beyond that the list scrolls inside itself instead of
     * pushing the dialog's own buttons out of reach.
     */
    .list {
      margin: var(--space-1) 0 0;
      padding: var(--space-1);
      max-height: calc(8 * var(--tap-row));
      overflow-y: auto;
      list-style: none;
      border: 1px solid var(--color-field-line);
      border-radius: var(--radius-field);
      background: var(--color-card);
      box-shadow: var(--shadow-card);
    }

    .list:focus-visible {
      /* The ring belongs on the trigger; a second one around the open list is noise. */
      outline: none;
    }

    .option {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: var(--tap-row);
      padding: 0 var(--space-3);
      border-radius: calc(var(--radius-field) - 6px);
      color: var(--color-ink);
      font-size: var(--text-body);
      cursor: pointer;
    }

    .option__name {
      flex-grow: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .option__tick {
      flex: none;
      color: var(--color-accent-deep);
    }

    .option--chosen {
      font-weight: 600;
    }

    /*
     * One highlight, driven by the keyboard *and* the mouse, because there is only one active
     * option and both inputs move it. Tinted rather than reversed: a solid accent bar under
     * white text is the system popup this control exists to stop looking like.
     */
    .option--active {
      background: var(--color-accent-tint-1);
    }

    @media (hover: hover) and (pointer: fine) {
      .option:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class SelectField {
  /** The field's label, already translated. */
  readonly label = input.required<string>();
  /** What the trigger says while nothing is chosen. */
  readonly placeholder = input.required<string>();
  readonly options = input.required<readonly SelectOption[]>();
  /** The chosen id, or `''`. One-way in: the screen owns the value and answers {@link changed}. */
  readonly value = input('');

  readonly changed = output<string>();

  protected readonly open = signal(false);

  /** Which option the keyboard is on. `-1` while nothing is highlighted. */
  protected readonly active = signal(-1);

  protected readonly chosen = computed(
    () => this.options().find((option) => option.id === this.value()) ?? null,
  );

  /** Unique per instance, so two of these on one screen keep their ARIA wiring apart. */
  private readonly seed = Math.random().toString(36).slice(2, 9);
  protected readonly labelId = `sel-l-${this.seed}`;
  protected readonly triggerId = `sel-t-${this.seed}`;
  protected readonly listId = `sel-o-${this.seed}`;

  protected optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  protected readonly activeId = computed(() =>
    this.active() >= 0 ? this.optionId(this.active()) : null,
  );

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly host = inject(ElementRef<HTMLElement>);

  constructor() {
    /*
     * Focus follows the list into and out of existence.
     *
     * An `effect` rather than a call inside `toggle()`: the list is rendered by `@if`, so at the
     * moment the signal flips there is no element to focus. This runs after the view has caught
     * up, which is the only point at which either half is possible.
     */
    effect(() => {
      const list = this.list()?.nativeElement;
      if (this.open() && list) {
        list.focus();
        this.scrollActiveIntoView();
      }
    });
  }

  protected toggle(): void {
    this.open() ? this.shut() : this.reveal();
  }

  /**
   * Open, with the highlight on what is already chosen.
   *
   * Not on the first row: a founder reopening the list to check what he picked should see it, and
   * one press of Down from there moves to the next customer rather than to the second one.
   */
  private reveal(): void {
    if (this.options().length === 0) {
      return;
    }
    const current = this.options().findIndex((option) => option.id === this.value());
    this.active.set(current >= 0 ? current : 0);
    this.open.set(true);
  }

  private shut(focusTrigger = false): void {
    this.open.set(false);
    if (focusTrigger) {
      this.trigger().nativeElement.focus();
    }
  }

  protected choose(option: SelectOption): void {
    this.changed.emit(option.id);
    // Back to the trigger, because that is now the thing on screen saying what was chosen — and
    // because a keyboard user who has just committed must not be left focused on nothing.
    this.shut(true);
  }

  protected onTriggerKey(event: KeyboardEvent): void {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      this.reveal();
    }
  }

  protected onListKey(event: KeyboardEvent): void {
    const count = this.options().length;
    if (count === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveTo(Math.min(this.active() + 1, count - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveTo(Math.max(this.active() - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        this.moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        this.moveTo(count - 1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const option = this.options()[this.active()];
        if (option) {
          this.choose(option);
        }
        break;
      }
      case 'Escape':
        // Not on the document: this opens inside a dialog that also closes on Escape, and a
        // document-level handler would shut both on one keypress. `stopPropagation` is what keeps
        // the two apart — the dialog still closes on Escape when the list is not open.
        event.preventDefault();
        event.stopPropagation();
        this.shut(true);
        break;
      case 'Tab':
        // Let the focus move; just do not leave an open list behind on a screen he has left.
        this.shut();
        break;
      default:
        break;
    }
  }

  private moveTo(index: number): void {
    this.active.set(index);
    this.scrollActiveIntoView();
  }

  /**
   * Keep the highlight inside the scroll box, or the arrow keys walk it off the bottom edge.
   *
   * By index rather than by id selector: `CSS.escape` is the correct way to build one and `CSS`
   * itself does not exist in every environment this code runs in — it is absent under the test
   * renderer, where reaching for it turned every spec in this file red. `scrollIntoView` is
   * optional for the same reason, and losing it costs a scroll position rather than a behaviour.
   */
  private scrollActiveIntoView(): void {
    const rows = this.list()?.nativeElement.querySelectorAll<HTMLElement>('[role="option"]');
    rows?.[this.active()]?.scrollIntoView?.({ block: 'nearest' });
  }

  protected onDocumentClick(event: Event): void {
    const target = event.target as Node | null;
    // The trigger's own click already ran `toggle()` and bubbled here; without this the two would
    // cancel out and the list would never open on a tap.
    if (target && !(this.host.nativeElement as HTMLElement).contains(target)) {
      this.shut();
    }
  }
}
