import type { BoardSettings } from '../types/board';

/**
 * Builds the editor URL for a card, or undefined while `path` is unset. Pure string work on
 * settings, so it stays out of the filesystem layer and out of the marketing bundle's way.
 */
export function editorUrl(settings: BoardSettings, card: { name: string }): string | undefined {
  if (!settings.path) return undefined;

  // Windows paths need forward slashes and a leading one to be valid in a URL.
  let root = settings.path.replaceAll('\\', '/');
  while (root.endsWith('/')) root = root.slice(0, -1);
  const absolute = `${root.startsWith('/') ? '' : '/'}${root}/${card.name}`;

  return settings.editor.replace('{path}', encodeURI(absolute));
}

/** "vscode://file{path}" -> "VS Code", so the link names the app it will launch. */
export function editorName(settings: Pick<BoardSettings, 'editor'>): string {
  const scheme = /^([a-z][\w+.-]*):/i.exec(settings.editor)?.[1] ?? 'editor';
  if (scheme.toLowerCase() === 'vscode') return 'VS Code';
  return scheme.charAt(0).toUpperCase() + scheme.slice(1);
}
