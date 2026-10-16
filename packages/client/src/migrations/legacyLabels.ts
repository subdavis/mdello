import type { Label } from '../types/board';

const LEGACY_KEY = 'mdello:labels';

/**
 * One-time lift of labels out of localStorage, for boards created before they lived in the
 * board's config file. Reading clears the key, so this returns something at most once.
 */
export function takeLegacyLabels(): Label[] {
  if (typeof localStorage === 'undefined') return [];

  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
  } catch {
    // Corrupt entry: nothing to migrate.
  }
  localStorage.removeItem(LEGACY_KEY);
  if (!Array.isArray(stored)) return [];

  return stored
    .filter(
      (entry) =>
        typeof entry?.name === 'string' && entry.name.trim() && typeof entry?.color === 'string',
    )
    .map(({ name, color }) => ({ name, color }));
}
