import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTheme,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from './theme.ts';

test('parses known preferences and defaults missing or invalid values to system', () => {
  assert.equal(parseThemePreference('dark'), 'dark');
  assert.equal(parseThemePreference('light'), 'light');
  assert.equal(parseThemePreference('system'), 'system');
  assert.equal(parseThemePreference(null), 'system');
  assert.equal(parseThemePreference('sepia'), 'system');
});

test('resolves system preference and preserves explicit preferences', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
});

test('loads and saves theme preference', () => {
  const values = new Map<string, string>([[THEME_STORAGE_KEY, 'dark']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(loadThemePreference(storage), 'dark');
  saveThemePreference(storage, 'system');
  assert.equal(values.get(THEME_STORAGE_KEY), 'system');
});

test('unavailable storage falls back safely', () => {
  const storage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  assert.equal(loadThemePreference(null), 'system');
  assert.equal(loadThemePreference(storage), 'system');
  assert.doesNotThrow(() => saveThemePreference(null, 'dark'));
  assert.doesNotThrow(() => saveThemePreference(storage, 'dark'));
});

test('applies resolved theme to document root data', () => {
  const root = { dataset: {} as DOMStringMap };

  applyTheme(root, 'dark');

  assert.equal(root.dataset.theme, 'dark');
});
