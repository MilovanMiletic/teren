/**
 * The worker's activation code, as this phone reads it off a WhatsApp message.
 *
 * Eight characters of Crockford base32, shown as `XKD4-7HMP` (`plans/profile-and-identity.md`
 * §5). Crockford rather than an alphabet invented this afternoon: its alphabet already excludes
 * `I`, `L`, `O` and `U`, so the ambiguity a man meets at arm's length in the sun is solved by a
 * published convention, and its **decode-time folding** means someone who writes an "O" still
 * gets in.
 *
 * ## Both halves must fold identically
 *
 * The server's half is `src/Teren.Core/Identity/ActivationCodeFormat.cs`, whose doc comment is the
 * contract. In order:
 *
 * 1. drop everything that is not a letter or a digit — spaces, dashes, zero-width characters, a
 *    stray emoji pasted out of a chat message;
 * 2. uppercase (invariant);
 * 3. map `O`→`0`, `I`→`1`, `L`→`1`, `U`→`V`;
 * 4. accept only if what is left is exactly 8 characters of {@link ACTIVATION_CODE_ALPHABET}.
 *
 * ## Where this half deliberately does more, and why it is safe
 *
 * **This side also folds Cyrillic homoglyphs; the server does not.** The server drops every
 * non-ASCII character, Cyrillic included. A Serbian foreman typing on a Cyrillic keyboard
 * produces `С` and `Т` and `О` — characters that are pixel-identical to `C`, `T` and `O` and that
 * a server-side fold would silently *delete*, leaving him six characters where he can see eight
 * and no possible hint on screen about which two are wrong. That is a dead end, on the one screen
 * between a foreman and the record button.
 *
 * It is safe because the client sends what this function produced, never what was typed: after
 * folding, the string is pure ASCII, and the server's fold over it is the identity. The two
 * halves therefore agree on every code this app submits. They would *disagree* about a Cyrillic
 * code submitted by some other client — so the right end state is for the server to adopt the
 * same table. See the report accompanying F3.
 *
 * Everything here is a pure function over a string. No component reaches for these rules itself:
 * the screen folds on input, folds on paste, and validates with {@link isCompleteActivationCode},
 * so there is exactly one description of what a code is.
 */

/** Crockford's encoding alphabet: no `I`, no `L`, no `O`, no `U`. */
export const ACTIVATION_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 8 characters at 5 bits each — 40 bits of entropy. */
export const ACTIVATION_CODE_LENGTH = 8;

/** Where the display dash goes: `XKD4-7HMP`. */
const GROUP_SIZE = 4;

/**
 * Cyrillic letters that are indistinguishable from a Latin one at a glance, mapped to the Latin
 * they look like.
 *
 * Uppercase only — the fold uppercases first, and `'о'.toUpperCase()` is `'О'`, so both cases are
 * covered by ten entries rather than twenty.
 *
 * The set is deliberately the *visually identical* ones. `В` (looks like B), `Н` (looks like H)
 * and `Ј` (looks like J) are equally strong candidates and are left out only because the ten
 * below are the table the plan named; adding to it is a decision to take with the server half, in
 * one place, not a convenience to slip in on one side.
 */
const CYRILLIC_HOMOGLYPHS: Readonly<Record<string, string>> = {
  О: 'O',
  А: 'A',
  Е: 'E',
  К: 'K',
  М: 'M',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
};

/** Crockford's decode-time folding, applied after the homoglyph pass. */
const CROCKFORD_FOLD: Readonly<Record<string, string>> = {
  O: '0',
  I: '1',
  L: '1',
  U: 'V',
};

/**
 * Fold anything a keyboard or a clipboard can produce into canonical form.
 *
 * Total and idempotent: every input has an answer, and folding a folded string changes nothing.
 * It does **not** truncate — `slice(0, ACTIVATION_CODE_LENGTH)` is the caller's decision, because
 * the screen wants the first eight characters of a paste while a validity check wants to know
 * that nine were offered.
 */
export function foldActivationCode(input: string | null | undefined): string {
  if (!input) {
    return '';
  }

  let folded = '';
  for (const raw of input) {
    // Uppercase first: it is what turns 'о' into 'О' for the homoglyph table below, and 'a' into
    // 'A' for the alphabet.
    const upper = raw.toUpperCase();
    const latin = CYRILLIC_HOMOGLYPHS[upper] ?? upper;

    // Separators, whitespace, zero-width characters, pasted emoji and every remaining non-Latin
    // letter land here. An emoji is more than one code unit; iterating the string by code point
    // (`for…of`) is what keeps a surrogate pair from surviving as half a character.
    if (!/^[0-9A-Z]$/.test(latin)) {
      continue;
    }

    folded += CROCKFORD_FOLD[latin] ?? latin;
  }
  return folded;
}

/** Whether a folded string is a whole code — the only thing that may enable the submit button. */
export function isCompleteActivationCode(folded: string): boolean {
  return (
    folded.length === ACTIVATION_CODE_LENGTH &&
    [...folded].every((character) => ACTIVATION_CODE_ALPHABET.includes(character))
  );
}

/**
 * The form a human reads and types: `XKD4-7HMP`.
 *
 * Applied as he types, so the dash appears where the message he is copying from has one and the
 * two halves line up visually. Anything shorter than a group is returned unchanged — a dash
 * appearing after the fourth character he types is an affordance; a dash appearing before it is
 * a puzzle.
 */
export function formatActivationCode(folded: string): string {
  return folded.length <= GROUP_SIZE
    ? folded
    : `${folded.slice(0, GROUP_SIZE)}-${folded.slice(GROUP_SIZE)}`;
}

/**
 * Fold, cap at eight, and format — what the field shows after any edit or paste.
 *
 * The cap is why paste is handled explicitly: a message pasted whole ("Kod: XKD4-7HMP") folds to
 * more than eight characters, and taking the first eight of *that* would be wrong. Callers strip
 * the prose; this function's job is only that a nine-character paste does not become a
 * nine-character field.
 */
export function displayActivationCode(input: string | null | undefined): string {
  return formatActivationCode(foldActivationCode(input).slice(0, ACTIVATION_CODE_LENGTH));
}
