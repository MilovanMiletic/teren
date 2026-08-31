import {
  ACTIVATION_CODE_ALPHABET,
  displayActivationCode,
  foldActivationCode,
  formatActivationCode,
  isCompleteActivationCode,
} from './activation-code';

/**
 * The folding table, character by character.
 *
 * This is the one piece of F3 that has a counterpart on the server
 * (`src/Teren.Core/Identity/ActivationCodeFormat.cs`). If the two disagree, a code works in one
 * place and not the other, and the man holding it has no way to find out which. So every rule is
 * pinned here rather than trusted to read correctly.
 */
describe('activation code folding', () => {
  it('drops separators, whitespace, zero-width characters and pasted emoji', () => {
    // A code long-pressed out of a chat message brings its neighbourhood with it.
    expect(foldActivationCode('XKD4-7HMP')).toBe('XKD47HMP');
    expect(foldActivationCode(' xkd4 7hmp ')).toBe('XKD47HMP');
    expect(foldActivationCode('XKD4​-‍7HMP')).toBe('XKD47HMP');
    // Note the prose folds too — the 'O' of 'Kod' is a zero by Crockford's rule, which is why the
    // field shows the first eight characters it will actually send rather than what was pasted.
    expect(foldActivationCode('Kod: XKD4-7HMP 👍')).toBe('K0DXKD47HMP');
  });

  it('uppercases, so a keyboard that lowercases everything costs nothing', () => {
    expect(foldActivationCode('xkd47hmp')).toBe('XKD47HMP');
  });

  it('applies Crockford decode-time folding — O to 0, I and L to 1, U to V', () => {
    expect(foldActivationCode('OILU')).toBe('011V');
    expect(foldActivationCode('oilu')).toBe('011V');
  });

  /**
   * The rule this half has that the server's does not, and the reason it is here.
   *
   * A Serbian foreman on a Cyrillic keyboard types characters that are pixel-identical to Latin
   * ones. The server drops every non-ASCII character, so `СТО` would reach it as nothing at all —
   * leaving him six characters where he can see eight, with no possible hint on screen about
   * which two vanished. Folded here, what goes on the wire is ASCII the server agrees with.
   */
  it('folds Cyrillic homoglyphs to the Latin letters they are indistinguishable from', () => {
    // О А Е К М Р С Т У Х — every one of them looks exactly like the Latin letter it maps to.
    expect(foldActivationCode('ОАЕКМРСТУХ')).toBe('0AEKMPCTYX');
    // Lowercase too: the fold uppercases before it looks the character up.
    expect(foldActivationCode('оаекмрстух')).toBe('0AEKMPCTYX');
    // And the fold chains: Cyrillic О becomes Latin O, which Crockford then reads as zero.
    expect(foldActivationCode('ХКД4-7НМР')).toBe('XK47MP');
  });

  it('is idempotent and total — anything at all can be handed to it', () => {
    const once = foldActivationCode('о i L u -- 4');
    expect(foldActivationCode(once)).toBe(once);
    expect(foldActivationCode(null)).toBe('');
    expect(foldActivationCode(undefined)).toBe('');
    expect(foldActivationCode('')).toBe('');
    expect(foldActivationCode('čćžšđ')).toBe('');
  });

  it('accepts a code only when eight characters of the alphabet survive', () => {
    expect(isCompleteActivationCode('XKD47HMP')).toBe(true);
    expect(isCompleteActivationCode('XKD47HM')).toBe(false);
    expect(isCompleteActivationCode('XKD47HMPQ')).toBe(false);
    // The alphabet has no I, L, O or U — anything folded is already inside it, which is why a
    // fold of arbitrary ASCII can never produce a character this rejects.
    for (const character of ACTIVATION_CODE_ALPHABET) {
      expect(isCompleteActivationCode(character.repeat(8))).toBe(true);
    }
  });

  it('shows the code the way the message he is copying from does', () => {
    expect(formatActivationCode('XKD47HMP')).toBe('XKD4-7HMP');
    // A dash appearing before the fourth character would be a puzzle, not an affordance.
    expect(formatActivationCode('XKD')).toBe('XKD');
    expect(formatActivationCode('XKD4')).toBe('XKD4');
    expect(formatActivationCode('XKD45')).toBe('XKD4-5');
  });

  /**
   * What the field itself does with a paste.
   *
   * The cap matters: a whole sentence pasted out of Viber folds to more than eight characters,
   * and a nine-character paste must not become a nine-character field. Truncation happens after
   * folding, never before — cutting `XKD4-7HMP` at eight raw characters would keep the dash and
   * lose the last letter.
   */
  it('folds, caps at eight and formats what a paste leaves in the field', () => {
    expect(displayActivationCode('XKD4-7HMP')).toBe('XKD4-7HMP');
    expect(displayActivationCode('xkd47hmpZZZ')).toBe('XKD4-7HMP');
    expect(displayActivationCode('x')).toBe('X');
    expect(displayActivationCode('')).toBe('');
  });
});
