export type Language = 'sr' | 'en';

export const AVAILABLE_LANGUAGES: readonly Language[] = ['sr', 'en'];

/** Serbian is the default: the people using this on a site do not read English. */
export const DEFAULT_LANGUAGE: Language = 'sr';

/** Angular ships Serbian Latin as `sr-Latn`; there is no `sr-Latn-RS` locale file. */
export const LOCALE_BY_LANGUAGE: Record<Language, string> = {
  sr: 'sr-Latn',
  en: 'en',
};

const STORAGE_KEY = 'teren.language';

function isLanguage(value: unknown): value is Language {
  return value === 'sr' || value === 'en';
}

export function activeLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) {
      return stored;
    }
  } catch {
    // Storage can be unavailable in private mode; the default is a fine answer.
  }
  return DEFAULT_LANGUAGE;
}

export function persistLanguage(language: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // The choice just will not survive a reload.
  }
}
