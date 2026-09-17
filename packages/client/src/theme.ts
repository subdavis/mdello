export const THEME_STORAGE_KEY = 'mdello-theme';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ThemeRoot {
  dataset: DOMStringMap;
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function loadThemePreference(storage: ThemeStorage | null): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function saveThemePreference(
  storage: ThemeStorage | null,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme still applies for this session when storage is blocked or full.
  }
}

export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.dataset.theme = theme;
}
