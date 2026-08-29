import en from '../../public/i18n/en.json';
import sr from '../../public/i18n/sr.json';
import { AVAILABLE_LANGUAGES, DEFAULT_LANGUAGE } from './i18n';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('translation dictionaries', () => {
  const srKeys = leafKeys(sr).sort();
  const enKeys = leafKeys(en).sort();

  it('define exactly the same keys — no user-facing string may exist in one language only', () => {
    expect(srKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
    expect(enKeys.filter((key) => !srKeys.includes(key))).toEqual([]);
  });

  it('leave nothing blank', () => {
    for (const dictionary of [sr, en]) {
      const empty = leafKeys(dictionary).filter((key) => !read(dictionary, key)?.trim());
      expect(empty).toEqual([]);
    }
  });

  it('carry every plural form both languages are looked up with', () => {
    for (const form of ['zero', 'one', 'few', 'other']) {
      expect(srKeys).toContain(`common.photos.${form}`);
      expect(enKeys).toContain(`common.photos.${form}`);
    }
  });

  it('keeps Serbian the default runtime locale', () => {
    expect(DEFAULT_LANGUAGE).toBe('sr');
    expect(AVAILABLE_LANGUAGES).toContain('sr');
    expect(AVAILABLE_LANGUAGES).toContain('en');
  });
});

function read(dictionary: unknown, key: string): string | undefined {
  return key
    .split('.')
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | undefined)?.[part],
      dictionary,
    ) as string | undefined;
}
