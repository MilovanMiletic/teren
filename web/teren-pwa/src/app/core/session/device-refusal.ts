/**
 * The one thing a signed-out phone leaves behind: a note saying it happened.
 *
 * ## Why a marker exists at all
 *
 * **Founder decision, 2026-09-03: a phone whose credential the server refuses signs itself out.**
 * The sign-out is silent from the app's point of view — one `localStorage` row goes and the router
 * puts the man on `/welcome` — and a man who is standing on a screen he did not ask for, with the
 * record button gone, is owed a sentence. `/welcome` cannot work out for itself why it is being
 * shown: it is also the ordinary first screen of a phone nobody has ever activated, and those two
 * arrivals need opposite copy.
 *
 * So the refusal writes a note and the screen reads it. This is the same shape as the admin
 * surface's own remedy (`ui/sign-in-again.ts`, which decides what to draw from the credential
 * rather than from a boolean passed down through seven screens): the fact is recorded once, in one
 * place, and the screen that can act on it asks.
 *
 * ## Why `localStorage` and not a service field
 *
 * The sign-out may be followed by a reload — the foreman puts the phone away and comes back, iOS
 * discards the tab — and an in-memory flag would take the explanation with it while
 * `requiresDevice` went on sending him to `/welcome`. It is also, deliberately, the *same* store
 * the credential itself lives in: a note about a credential has exactly the lifetime of that
 * credential's absence, and it can fail exactly as harmlessly (see `session.ts` for why every
 * failure mode here ends at "no note" rather than at a throw).
 *
 * **It is not evidence and it is not a credential.** It holds one ISO timestamp and says nothing
 * about who was signed out or why — the 401 that produced it is deliberately reasonless (a revoked
 * phone, a removed worker and a suspended company are byte-identical from here), and a note that
 * guessed would be the app inventing an oracle the server refuses to be.
 *
 * ## It describes a condition, so it lasts as long as the condition
 *
 * `/welcome` **reads it and never consumes it.** The note means *this phone holds no credential
 * because the server refused one*, and that is true on every draw of the screen until an
 * activation makes it false — which is why {@link clearDeviceRefusal} has exactly one caller,
 * `ActivationService.activate`.
 *
 * The first cut of this file read it once and cleared it, on the `ArrivalHandoff.take()` model, and
 * the review walked out what that costs: signed out mid-shift, phone pocketed, iOS discards the
 * tab, he reopens the app, `requiresDevice` puts him on `/welcome` — and he reads the plain
 * first-run screen with the record button gone and nothing saying why, which is the exact
 * complaint this increment exists to answer, one reload later. Tapping "Prijavi se" and coming
 * back cost the sentence too, and so did a deferred navigation that fired while the screen was
 * off. **A handoff between two screens inside one navigation is not the same kind of thing as a
 * durable state**, and this is the second.
 *
 * It cannot go stale, which is what makes durability safe here: it names no cause, so there is no
 * fact in it that time can falsify, and a phone that is never re-activated goes on reading a
 * sentence that is still exactly true.
 */

/** Where the note lives. Its own key, beside `teren.session` rather than inside it. */
export const DEVICE_REFUSAL_STORAGE_KEY = 'teren.deviceRefused';

/**
 * Write the note: the moment the server's refusal was acted on.
 *
 * A timestamp rather than a bare flag, because a flag can only ever answer "yes" and the stamp
 * answers "when" as well, at the same cost. **Nothing renders it today** — the sentence on
 * `/welcome` is deliberately timeless, since a time is one more thing to read on the screen
 * standing between a man and the record button — and it is stored because the alternative is a
 * second storage migration on the day somebody wants it.
 *
 * Best effort, exactly like `persistSession`: a quota error costs the sentence, never the
 * sign-out, and the sign-out is the part that had to happen.
 */
export function markDeviceRefusal(at: string = new Date().toISOString()): void {
  try {
    localStorage.setItem(DEVICE_REFUSAL_STORAGE_KEY, at);
  } catch {
    // Private mode or an exhausted quota. `/welcome` will simply be its ordinary self.
  }
}

/**
 * The note, or `null` when there is not one.
 *
 * Narrowed to a non-empty string for the reason `readStoredSession()` narrows a whole session: a
 * row written by an older build, or half-written, must resolve to "no note" rather than to a
 * truthy value the screen would render a notice for.
 */
export function readDeviceRefusal(): string | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DEVICE_REFUSAL_STORAGE_KEY);
  } catch {
    // Storage unavailable. Indistinguishable, from here, from never having been refused.
    return null;
  }
  return raw && raw.trim().length > 0 ? raw : null;
}

/**
 * Forget the note, because the condition it describes has ended.
 *
 * **One caller: `ActivationService.activate`, on success.** That is the only event in the product
 * that makes the note false — this phone now holds a credential a server issued seconds ago — and
 * it covers every route back in, including the man who goes straight to `/activate` from a
 * bookmark or the pending screen's own button and never passes `/welcome` at all.
 *
 * `/welcome` deliberately does **not** call this. See the file comment for the reload that
 * argument was lost on.
 */
export function clearDeviceRefusal(): void {
  try {
    localStorage.removeItem(DEVICE_REFUSAL_STORAGE_KEY);
  } catch {
    // Private mode; there was nothing persisted to remove.
  }
}
