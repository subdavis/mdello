import { dump, load } from 'js-yaml';
import { openWritable } from './writable';

export const CONFIG_FILE = '.mdello.yml';

export interface Label {
  name: string;
  color: string;
}

export interface BoardConfig {
  /** Absolute path of the board folder on disk; only the user can supply it. */
  path: string;
  /** URL template used to open a card in an external editor. */
  editor: string;
  labels: Label[];
}

const DEFAULT_EDITOR = 'vscode://file{path}';

export const DEFAULT_CONFIG: BoardConfig = {
  path: '',
  editor: DEFAULT_EDITOR,
  labels: [],
};

/** Comments are re-emitted on every write because js-yaml's dump() cannot keep them. */
const HEADER = `# mdello board config — written by the app, safe to hand-edit.
#
# path    Absolute path of THIS folder. The browser's File System Access API never
#         reveals real paths, so mdello cannot fill this in for you. Once it is set,
#         the "open in editor" link on each card starts working.
#           example: /Users/you/Documents/mdello
#
# editor  URL template for that link; {path} becomes the card's absolute file path.
#         Custom schemes are the only way a web page can hand a file to a native app.
#           vscode://file{path}          VS Code
#           cursor://file{path}          Cursor
#           obsidian://open?path={path}  Obsidian
#
# Wallpaper: drop a file named background.<ext> in this folder. Any format the browser
#            can render works; it is drawn centred and cropped to cover.
#
# labels  Tag colours. They live here so they travel with the board instead of
#         being stuck in one browser's local storage.
`;

function readLabels(value: unknown): Label[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (entry) =>
        typeof entry?.name === 'string' && entry.name.trim() && typeof entry?.color === 'string',
    )
    .map(({ name, color }) => ({ name, color }));
}

/** Missing or corrupt config is not an error: fall back to defaults. */
export async function readConfig(root: FileSystemDirectoryHandle): Promise<BoardConfig> {
  let raw: unknown = null;
  try {
    const handle = await root.getFileHandle(CONFIG_FILE);
    raw = load(await (await handle.getFile()).text());
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  const data = (raw ?? {}) as Record<string, unknown>;
  return {
    path: typeof data.path === 'string' ? data.path.trim() : '',
    editor: typeof data.editor === 'string' && data.editor ? data.editor : DEFAULT_EDITOR,
    labels: readLabels(data.labels),
  };
}

export async function writeConfig(
  root: FileSystemDirectoryHandle,
  config: BoardConfig,
): Promise<void> {
  const handle = await root.getFileHandle(CONFIG_FILE, { create: true });
  const writable = await openWritable(handle);
  await writable.write(HEADER + dump(config, { lineWidth: -1 }));
  await writable.close();
}

/** Builds the editor URL for a card, or undefined while `path` is unset. */
export function editorUrl(
  config: BoardConfig,
  card: { column: string; name: string },
): string | undefined {
  if (!config.path) return undefined;

  // Windows paths need forward slashes and a leading one to be valid in a URL.
  let root = config.path.replaceAll('\\', '/');
  while (root.endsWith('/')) root = root.slice(0, -1);
  const absolute = `${root.startsWith('/') ? '' : '/'}${root}/${card.column}/${card.name}`;

  return config.editor.replace('{path}', encodeURI(absolute));
}

/** "vscode://file{path}" -> "VS Code", so the link names the app it will launch. */
export function editorName(config: BoardConfig): string {
  const scheme = /^([a-z][\w+.-]*):/i.exec(config.editor)?.[1] ?? 'editor';
  if (scheme.toLowerCase() === 'vscode') return 'VS Code';
  return scheme.charAt(0).toUpperCase() + scheme.slice(1);
}
