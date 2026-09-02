import { ACTION_PATTERN, MAX_ACTION_LENGTH, isAction } from './client-event';

/**
 * What a click is called — **derived from the shape of the DOM and never from what it says.**
 *
 * ## This is the privacy boundary of the whole logging feature
 *
 * A global click listener is the only way to get the breadth the founder asked for ("logs need to
 * be detailed from every action that was clicked on the app"), and the obvious way to describe a
 * click is the obvious mistake: an element's text, its `aria-label`, its `title` or its `value`
 * are every one of them **translated, user-facing strings**, and on this product's screens two of
 * them carry a project name — `platform.person.open` is "Open {{name}}", the header names the
 * site, a diary row names an address. Reading any of them here would ship a customer's commercial
 * data into a log table that Teren staff can read, which is precisely the thing
 * `PlatformPrivacyTests` exists to make impossible on the server side.
 *
 * So a descriptor is built from three structural facts only: an explicit `data-log` slug, the
 * element's tag, and its class names. None of those is ever translated, and none of them is ever
 * derived from content. `action-descriptor.spec.ts` scans this file for the four forbidden
 * accessors and fails on any of them, because a future edit that reaches for `textContent`
 * "just to make the logs readable" is the one change that would look like an improvement.
 *
 * ## Two kinds of name, and why both exist
 *
 * - **`data-log="capture.record.start"`** — a control that declares itself. The slug goes on the
 *   wire verbatim, so the vocabulary in the contract is opt-in per control and a log line reads
 *   like a sentence about the product.
 * - **`ui.app-column-menu.button.more`** — everything else. The `ui.` prefix marks it as
 *   structural, and it is greppable: a founder who sees a burst of them on one route knows what
 *   was pressed even though nobody has named that button yet.
 *
 * Clicks on plain text, on the page background and on decorations produce `null` and are not
 * recorded. A log of every mouse-down on a paragraph is noise that hides the presses that matter.
 */

/** How far up the tree a `data-log` declaration is looked for. */
const DECLARATION_DEPTH = 8;

/** What counts as something a person meant to press. */
const ACTIONABLE = 'button, a[href], [role="button"], input, select, summary, label';

/** A class name worth putting in a descriptor: BEM without the underscores. */
const CLASS_PATTERN = /^[a-z][a-z0-9-]{0,28}$/;

/** Angular component hosts are custom elements, and a hyphen is what makes one. */
const COMPONENT_TAG = /^[a-z][a-z0-9]*-[a-z0-9-]+$/;

/** Where the fallback lands when nothing structural survives the rules above. */
export const UNNAMED_CLICK = 'ui.click';

/**
 * Name the thing that was clicked, or return `null` if it was not a control.
 *
 * @param target the deepest element under the pointer — `event.target`, already narrowed.
 */
export function describeClick(target: EventTarget | null): string | null {
  const element = asElement(target);
  if (!element) {
    return null;
  }

  const declared = declaredSlug(element);
  if (declared) {
    return declared;
  }

  const control = closestActionable(element);
  if (!control) {
    return null;
  }

  return structuralSlug(control);
}

/**
 * A `data-log` slug declared on the control or on one of its ancestors.
 *
 * Bounded rather than `closest()`, so a slug declared on a whole screen cannot swallow every
 * click inside it: eight levels reach a button inside its card inside its section, and stop well
 * short of the route outlet.
 *
 * A declaration that is not a valid action is ignored rather than sent — the server would refuse
 * the event whole, and a typo in a template must not cost the structural descriptor that would
 * otherwise have described the press.
 */
function declaredSlug(element: Element): string | null {
  let node: Element | null = element;
  for (let depth = 0; node && depth < DECLARATION_DEPTH; depth += 1) {
    const declared = node.getAttribute('data-log');
    if (declared && isAction(declared)) {
      return declared;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * The nearest ancestor that is a control, including the element itself.
 *
 * Hand-walked rather than `closest(ACTIONABLE)` for one reason: the walk has to stop somewhere,
 * and a click on the page background must answer `null` quickly rather than after crawling to
 * `<html>`. It also keeps this file free of a selector string that a test environment might
 * parse differently from a browser.
 */
function closestActionable(element: Element): Element | null {
  let node: Element | null = element;
  for (let depth = 0; node && depth < DECLARATION_DEPTH; depth += 1) {
    if (typeof node.matches === 'function' && node.matches(ACTIONABLE)) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * `ui.<component>.<tag>.<class>` — as much of it as survives the rules, and never more than the
 * contract's four dotted segments.
 *
 * The component host comes first because it is the most informative segment: `app-column-menu`
 * says which control was pressed, where `button` says only that something was. The class comes
 * last because it is the one part that a stylesheet refactor can change.
 */
function structuralSlug(control: Element): string {
  const segments: string[] = [];

  const host = componentHost(control);
  if (host) {
    segments.push(host);
  }

  segments.push(safeSegment(control.tagName.toLowerCase()) ?? 'el');

  const className = firstSafeClass(control);
  if (className) {
    segments.push(className);
  }

  const slug = ['ui', ...segments].join('.').slice(0, MAX_ACTION_LENGTH);
  // Truncation can leave a trailing dot or a half-written segment, and the server refuses the
  // event whole for either. The fallback is a worse name and a name that arrives.
  return ACTION_PATTERN.test(slug) ? slug : UNNAMED_CLICK;
}

/** The tag of the nearest Angular component the control sits inside, if any. */
function componentHost(control: Element): string | null {
  let node: Element | null = control;
  for (let depth = 0; node && depth < DECLARATION_DEPTH; depth += 1) {
    const tag = node.tagName.toLowerCase();
    if (COMPONENT_TAG.test(tag)) {
      return safeSegment(tag);
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * The first class name that is safe to print.
 *
 * Class names are structural — they come from this repo's own stylesheets, never from a server
 * response and never from anything a person typed. The `__` of a BEM element carries an
 * underscore, which the contract's segment alphabet does not allow, so it is folded to a hyphen
 * rather than dropping the whole class.
 */
function firstSafeClass(control: Element): string | null {
  const classes = (control.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  for (const raw of classes) {
    const segment = safeSegment(raw.replace(/_/g, '-'));
    if (segment) {
      return segment;
    }
  }
  return null;
}

function safeSegment(value: string): string | null {
  const lowered = value.toLowerCase();
  return CLASS_PATTERN.test(lowered) ? lowered : null;
}

/** An `EventTarget` that is an element, including a click that landed on a text node's parent. */
function asElement(target: EventTarget | null): Element | null {
  if (target && typeof (target as Element).getAttribute === 'function') {
    return target as Element;
  }
  return null;
}
