import { computed, ref } from 'vue';
import {
  applyTheme,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  type ThemePreference,
} from '../theme';

const preference = ref<ThemePreference>('system');
let storage: Storage | null = null;
let systemTheme: MediaQueryList | null = null;

function applyCurrentTheme(): void {
  const theme = resolveTheme(preference.value, systemTheme?.matches ?? false);
  applyTheme(document.documentElement, theme);
}

export function initializeTheme(): void {
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }

  preference.value = loadThemePreference(storage);
  systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  systemTheme.addEventListener('change', () => {
    if (preference.value === 'system') applyCurrentTheme();
  });
  applyCurrentTheme();
}

function setThemePreference(value: ThemePreference): void {
  preference.value = value;
  applyCurrentTheme();
  saveThemePreference(storage, value);
}

export function useTheme() {
  const themePreference = computed({
    get: () => preference.value,
    set: setThemePreference,
  });

  return { themePreference, setThemePreference };
}
