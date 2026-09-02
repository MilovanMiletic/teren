/**
 * Demo pacing, not test pacing.
 *
 * A test clicks the instant a locator resolves. A film has to let a viewer read the screen
 * first, see the pointer travel, and then see the tap — so every interaction here is
 * approach → beat → press → beat, and every screen gets a dwell long enough to be read.
 */
import { config } from '../config.mjs';

const { beat, dwell: defaultDwell, longDwell, typeDelay } = config.pace;

export const wait = (page, ms) => page.waitForTimeout(ms);
export const dwell = (page, ms = defaultDwell) => page.waitForTimeout(ms);
export const read = (page) => page.waitForTimeout(longDwell);

/** Moves the pointer to the middle of a locator in visible steps. */
export async function approach(page, locator, { steps = 18 } = {}) {
  await locator.waitFor({ state: 'visible', timeout: 20_000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error('approach(): the locator has no box on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
  return box;
}

/** Approach, pause so the viewer sees what is about to be pressed, press, pause again. */
export async function tap(page, locator, { after = beat, before = beat } = {}) {
  await approach(page, locator);
  await wait(page, before);
  await locator.click({ timeout: 20_000 });
  await wait(page, after);
}

/** Types into a field at a human rate, having visibly moved to it first. */
export async function fill(page, locator, text, { after = beat } = {}) {
  await approach(page, locator);
  await wait(page, 260);
  await locator.click();
  await locator.pressSequentially(text, { delay: typeDelay });
  await wait(page, after);
}

/** A slow scroll, so a long screen is shown rather than jumped through. */
export async function glide(page, distance, { stepPx = 60, stepMs = 26 } = {}) {
  const steps = Math.max(1, Math.round(Math.abs(distance) / stepPx));
  const direction = Math.sign(distance);
  for (let index = 0; index < steps; index += 1) {
    await page.mouse.wheel(0, direction * stepPx);
    await page.waitForTimeout(stepMs);
  }
  await wait(page, beat);
}

/** Parks the pointer out of the way — a dot resting on a word reads as a smudge. */
export async function park(page, { x = 20, y = 20 } = {}) {
  await page.mouse.move(x, y, { steps: 12 });
}
