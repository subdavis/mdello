import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readDesignTokens } from './designTokens.ts';

test('discovers global tokens, merges dark overrides, and excludes component declarations', () => {
  const tokens = readDesignTokens(`
    :root { --space-1: 0.25rem; --surface: #fff; }
    :root[data-theme="dark"] { --surface: #111; --dark-only: #222; }
    .component { --local: 5px; }
  `);
  assert.deepEqual(tokens, [
    { name: '--space-1', light: '0.25rem', dark: '0.25rem' },
    { name: '--surface', light: '#fff', dark: '#111' },
    { name: '--dark-only', light: '', dark: '#222' },
  ]);
});

test('includes every token in the app stylesheet without duplicate theme entries', () => {
  const source = readFileSync(new URL('./styles/style.css', import.meta.url), 'utf8');
  const tokens = readDesignTokens(source);
  const names = [...source.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
  assert.deepEqual(new Set(tokens.map(({ name }) => name)), new Set(names));
  assert.equal(tokens.length, new Set(names).size);
  assert.ok(tokens.every(({ light, dark }) => light && dark));
});
