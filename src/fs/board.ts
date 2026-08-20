import { findReferences, type Reference } from '../references';
import { CONFIG_FILE, DEFAULT_CONFIG, writeConfig } from './config';
import {
  type Frontmatter,
  parseFile,
  readNumber,
  readString,
  readTags,
  serializeFile,
} from './frontmatter';
import { openWritable } from './writable';

export const ARCHIVE_DIR = 'archive';

export interface Card {
  id: string;
  name: string;
  column: string;
  title: string;
  tags: string[];
  assignee?: string;
  created?: string;
  order?: number;
  modified: number;
  body: string;
  /** Parsed from the body on load and on save, never per keystroke. */
  references: Reference[];
  data: Frontmatter;
}

export interface Column {
  dir: string;
  label: string;
  cards: Card[];
}

// Handles are never kept in reactive state; everything is re-resolved by name.
async function columnHandle(root: FileSystemDirectoryHandle, column: string, create = false) {
  let dir = root;
  // Slash-separated so archive buckets (`archive/YYYY-MM`) resolve too.
  for (const part of column.split('/')) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

const PREFIX = /^(\d+)\s*[-_.]\s*/;

/** Name minus its numeric prefix, unslugified, so renumbering does not reshape the name. */
function stripPrefix(dir: string): string {
  const match = PREFIX.exec(dir);
  return match ? dir.slice(match[0].length) : dir;
}

function splitPrefix(dir: string): { order: number; label: string } {
  const match = PREFIX.exec(dir);
  const rest = match ? dir.slice(match[0].length) : dir;
  const label = rest
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return { order: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER, label: label || dir };
}

function toCard(column: string, name: string, text: string, modified: number): Card {
  let { data, body } = parseFile(text);

  /** Trim the empty line at the top of the file */
  body = body.trimStart();

  return {
    id: `${column}/${name}`,
    name,
    column,
    title: readString(data, 'title') ?? name.replace(/\.md$/, ''),
    tags: readTags(data),
    assignee: readString(data, 'assignee'),
    created: readString(data, 'created'),
    order: readNumber(data, 'order'),
    modified,
    body,
    references: findReferences(body),
    data,
  };
}

export async function readColumn(root: FileSystemDirectoryHandle, dir: string): Promise<Column> {
  const handle = await columnHandle(root, dir);
  const files: FileSystemFileHandle[] = [];

  // Directory listing is serial by nature; the reads that follow are not.
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue;
    files.push(entry);
  }

  const cards = await Promise.all(
    files.map(async (entry) => {
      const file = await entry.getFile();
      return toCard(dir, entry.name, await file.text(), file.lastModified);
    }),
  );

  // Explicit order wins; cards without one (hand-authored files) fall to the bottom, newest first.
  cards.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      b.modified - a.modified,
  );

  return { dir, label: splitPrefix(dir).label, cards };
}

/** Archive is never scanned: keeping it out of memory is the whole point of archiving. */
export async function scanBoard(root: FileSystemDirectoryHandle): Promise<Column[]> {
  const dirs = await listColumns(root);

  return Promise.all(dirs.map((dir) => readColumn(root, dir)));
}

export async function listColumns(root: FileSystemDirectoryHandle): Promise<string[]> {
  const dirs: string[] = [];

  for await (const entry of root.values()) {
    if (entry.kind !== 'directory') continue;
    if (entry.name === ARCHIVE_DIR || entry.name.startsWith('.')) continue;
    dirs.push(entry.name);
  }

  dirs.sort((a, b) => {
    const left = splitPrefix(a);
    const right = splitPrefix(b);
    return left.order - right.order || left.label.localeCompare(right.label);
  });

  return dirs;
}

export async function writeCard(
  root: FileSystemDirectoryHandle,
  card: Pick<Card, 'column' | 'name' | 'data' | 'body'>,
): Promise<number> {
  const dir = await columnHandle(root, card.column);
  const handle = await dir.getFileHandle(card.name, { create: true });
  const writable = await openWritable(handle);
  await writable.write(serializeFile(card.data, card.body));
  await writable.close();

  // Re-stat rather than Date.now(): refresh compares this against the file's
  // lastModified, and the two clocks never agree, so our own writes would always
  // look like external changes and get merged back over live card state.
  return (await handle.getFile()).lastModified;
}

/** Renumbers a column 1..n, rewriting only the files whose order actually changed. */
export async function persistOrder(root: FileSystemDirectoryHandle, column: Column): Promise<void> {
  for (const [index, card] of column.cards.entries()) {
    const order = index + 1;
    if (card.order === order) continue;

    card.order = order;
    card.data.order = order;
    card.modified = await writeCard(root, card);
  }
}

function slugify(title: string, fallback = 'card'): string {
  // split/join instead of trimming with `-+$`, which backtracks on long dash runs.
  const slug = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 60);

  return slug.replace(/-$/, '') || fallback;
}

async function uniqueDir(root: FileSystemDirectoryHandle, name: string): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? name : `${name}-${suffix}`;
    try {
      await root.getDirectoryHandle(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * Never invents or changes an extension: the name is used as given, and a collision only ever
 * adds `-1`, `-2` before the existing extension. `.DS_Store` stays `.DS_Store`.
 */
async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const match = /^(.+)(\.[^.]+)$/.exec(name);
  const base = match?.[1] ?? name;
  const ext = match?.[2] ?? '';

  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? `${base}${ext}` : `${base}-${suffix}${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate;
    }
  }
}

/** `order` is written up front so a new card is never written twice in a row. */
export async function createCard(
  root: FileSystemDirectoryHandle,
  column: string,
  title: string,
  order: number,
): Promise<Card> {
  const dir = await columnHandle(root, column);
  const name = await uniqueName(dir, `${slugify(title)}.md`);
  const data: Frontmatter = { title, tags: [], order, created: new Date().toISOString() };
  const modified = await writeCard(root, { column, name, data, body: '' });

  return { ...toCard(column, name, '', modified), title, data, order, modified };
}

const STARTER_COLUMNS = ['1-todo', '2-doing', '3-done'];

const SETUP_TAG = 'Setup';
const SETUP_COLOR = '#579dff';
const TUTORIAL_TAG = 'Tutorial';
const TUTORIAL_COLOR = '#4bce97';

const STARTER_CARDS: Array<{
  column: string;
  title: string;
  body: string;
  tags?: string[];
}> = [
  {
    column: '2-doing',
    title: 'Edit or Drag Me Around',
    tags: [TUTORIAL_TAG],
    body: [
      'Cards are markdown files. Columns are folders. That is the whole model.',
      '',
      '- Drag between columns to `mv` the file',
      '- Double-click the description to edit raw markdown',
      '- Press escape to exit and save the file',
      '- Edits also save automatically',
      '',
      'Edit me now to see the file change on disk. Double-click here.',
    ].join('\n'),
  },
  {
    column: '2-doing',
    title: 'Archive this card',
    tags: [TUTORIAL_TAG],
    body: [
      'Archiving takes a card off the board without deleting anything.',
      '',
      '- Drag a card onto the Archive strip at the edge of the board',
      `- The file moves to \`${ARCHIVE_DIR}/YYYY-MM/\`, bucketed by the month you archived it`,
      '- The archive folder is never scanned, so old cards cost nothing',
      '- Nothing is destroyed: move the file back into a column folder to restore it',
      '',
      'Try it on this card.',
    ].join('\n'),
  },
  {
    column: '1-todo',
    title: 'Set a background image',
    tags: [SETUP_TAG],
    body: [
      'Drag any image file onto the window. It is saved as `background.<ext>` in this board',
      'folder and drawn centred and cropped to cover.',
      '',
      'Need one?',
      '',
      '- [Default Mac wallpapers in 5K](https://512pixels.net/projects/default-mac-wallpapers-in-5k/)',
      '- [Public-domain paintings at the National Gallery of Art](https://www.nga.gov/artwork-search?images=1&begin_year=-499&end_year=1900&f[]=awtype:107231&f[]=movement:29206&f[]=movement:58341&f[]=movement:91366&f[]=movement:46221)',
      '',
      'Delete the file to go back to the plain board.',
    ].join('\n'),
  },
  {
    column: '1-todo',
    title: 'Update the config file',
    tags: [SETUP_TAG],
    body: [
      `Board settings live in \`${CONFIG_FILE}\` in this folder, next to the column folders,`,
      'so they travel with the board instead of hiding in one browser profile.',
      '',
      '| Key | What it does |',
      '| --- | --- |',
      '| `path` | Absolute path of this folder. The browser never reveals real paths, so fill it in by hand. Once set, the "open in editor" link on each card works. |',
      '| `editor` | URL template for that link; `{path}` becomes the card file path. `vscode://file{path}`, `cursor://file{path}`, `obsidian://open?path={path}` |',
      '| `labels` | Tag names and colours, like the blue Setup tag on this card. |',
      '',
      'Hand-edit it any time; mdello re-reads it and keeps the explanatory comments.',
    ].join('\n'),
  },
  {
    column: '1-todo',
    title: 'Install the agent skill',
    tags: [SETUP_TAG],
    body: [
      'Your board is just files, so an AI agent can read and write it with no MCP, tools or auth.',
      'Teach the agent the layout with the mdello skill:',
      '',
      '```bash',
      'npx skills add https://github.com/subdavis/mdello/blob/main/skills/mdello-board',
      '```',
      '',
      'Then ask it things like "what is on my board?" or "add a card for the release notes".',
    ].join('\n'),
  },
];

/** Scaffolds config, columns, an archive dir, and the starter cards into an empty folder. */
export async function initBoard(root: FileSystemDirectoryHandle): Promise<void> {
  await writeConfig(root, {
    ...DEFAULT_CONFIG,
    labels: [
      { name: SETUP_TAG, color: SETUP_COLOR },
      { name: TUTORIAL_TAG, color: TUTORIAL_COLOR },
    ],
  });
  for (const dir of STARTER_COLUMNS) await columnHandle(root, dir, true);
  await root.getDirectoryHandle(ARCHIVE_DIR, { create: true });

  const orders: Record<string, number> = {};
  for (const card of STARTER_CARDS) {
    const order = (orders[card.column] ?? 0) + 1;
    orders[card.column] = order;
    const created = await createCard(root, card.column, card.title, order);
    created.data.tags = card.tags ?? [];
    await writeCard(root, { ...created, body: card.body });
  }
}

async function moveFile(
  root: FileSystemDirectoryHandle,
  from: string,
  name: string,
  toDir: FileSystemDirectoryHandle,
): Promise<string> {
  const fromDir = await columnHandle(root, from);
  const handle = await fromDir.getFileHandle(name);
  const target = await uniqueName(toDir, name);

  if (handle.move) {
    try {
      await handle.move(toDir, target);
      return target;
    } catch {
      // Chrome's move() across directories is not always available; fall through to copy.
    }
  }

  const text = await (await handle.getFile()).text();
  const copy = await toDir.getFileHandle(target, { create: true });
  const writable = await copy.createWritable();
  await writable.write(text);
  await writable.close();

  // The source is dropped only after reading the copy back and matching it byte for byte.
  const written = await (await toDir.getFileHandle(target)).getFile();
  if ((await written.text()) !== text) {
    throw new Error(`Copy of ${name} could not be verified; source kept`);
  }
  await fromDir.removeEntry(name);

  return target;
}

export async function moveCard(
  root: FileSystemDirectoryHandle,
  card: Pick<Card, 'column' | 'name'>,
  toColumn: string,
): Promise<string> {
  return moveFile(root, card.column, card.name, await columnHandle(root, toColumn, true));
}

/** This month's archive bucket, created on demand. */
async function archiveBucket(
  root: FileSystemDirectoryHandle,
): Promise<{ dir: string; handle: FileSystemDirectoryHandle }> {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const archive = await root.getDirectoryHandle(ARCHIVE_DIR, { create: true });

  return {
    dir: `${ARCHIVE_DIR}/${month}`,
    handle: await archive.getDirectoryHandle(month, { create: true }),
  };
}

/** Returns where the file landed, so the move can be undone. */
export async function archiveCard(
  root: FileSystemDirectoryHandle,
  card: Pick<Card, 'column' | 'name'>,
): Promise<{ dir: string; name: string }> {
  const bucket = await archiveBucket(root);
  const name = await moveFile(root, card.column, card.name, bucket.handle);

  return { dir: bucket.dir, name };
}

export async function unarchiveCard(
  root: FileSystemDirectoryHandle,
  archived: { dir: string; name: string },
  toColumn: string,
): Promise<string> {
  return moveFile(root, archived.dir, archived.name, await columnHandle(root, toColumn, true));
}

/**
 * Chrome cannot move a directory, so a column "rename" is a fresh folder plus a file-by-file
 * move. Boards are small; correctness beats cleverness here. Returns the name it landed on.
 */
async function renameColumnDir(
  root: FileSystemDirectoryHandle,
  from: string,
  to: string,
): Promise<string> {
  if (from === to) return from;

  const target = await uniqueDir(root, to);
  const toDir = await root.getDirectoryHandle(target, { create: true });
  await emptyColumn(root, from, toDir);

  return target;
}

/**
 * Every file in a column folder, dotfiles included. Nested folders are refused outright: a
 * recursive move is not worth writing for a case the board model does not have.
 */
async function listColumnFiles(root: FileSystemDirectoryHandle, dir: string): Promise<string[]> {
  const handle = await columnHandle(root, dir);
  const names: string[] = [];

  for await (const entry of handle.values()) {
    if (entry.kind !== 'file') {
      throw new Error(`"${dir}" contains the folder "${entry.name}", so it cannot be moved here`);
    }
    names.push(entry.name);
  }

  return names;
}

/**
 * Moves every file out of a column, then removes the folder only after re-listing it and
 * finding it empty. Nothing is ever deleted here except the empty folder itself: OS litter
 * like `.DS_Store` is carried along rather than destroyed.
 */
async function emptyColumn(
  root: FileSystemDirectoryHandle,
  dir: string,
  toDir: FileSystemDirectoryHandle,
): Promise<{ files: string[]; cards: number }> {
  const files = await listColumnFiles(root, dir);
  for (const name of files) await moveFile(root, dir, name, toDir);

  const leftover = await listColumnFiles(root, dir);
  if (leftover.length) {
    throw new Error(
      `"${dir}" still holds ${leftover.join(', ')}, so the folder was kept. Nothing was lost.`,
    );
  }

  // Non-recursive, and only reached once the folder is verifiably empty.
  await root.removeEntry(dir);

  return { files, cards: files.filter((name) => name.endsWith('.md')).length };
}

/** Archives every file in a column, then removes the folder. Returns how many cards moved. */
export async function archiveColumn(root: FileSystemDirectoryHandle, dir: string): Promise<number> {
  const bucket = await archiveBucket(root);
  const { cards } = await emptyColumn(root, dir, bucket.handle);

  return cards;
}

/** New column folders keep the `<order>-<slug>` convention the rest of the board relies on. */
export async function createColumn(
  root: FileSystemDirectoryHandle,
  label: string,
  order: number,
): Promise<Column> {
  const dir = await uniqueDir(root, `${order}-${slugify(label, 'column')}`);
  await root.getDirectoryHandle(dir, { create: true });

  return { dir, label: splitPrefix(dir).label, cards: [] };
}

/** Keeps the existing prefix (or lack of one) and swaps only the label part of the name. */
export async function renameColumn(
  root: FileSystemDirectoryHandle,
  dir: string,
  label: string,
): Promise<string> {
  const { order } = splitPrefix(dir);
  const slug = slugify(label, 'column');
  const next = order === Number.MAX_SAFE_INTEGER ? slug : `${order}-${slug}`;

  return renameColumnDir(root, dir, next);
}

/** Renumbers columns 1..n in the given order, renaming only the folders that shifted. */
export async function persistColumnOrder(
  root: FileSystemDirectoryHandle,
  dirs: string[],
  onStep?: (done: number, total: number) => void,
): Promise<void> {
  const shifted = dirs.filter((dir, index) => splitPrefix(dir).order !== index + 1);
  let done = 0;
  onStep?.(0, shifted.length);

  for (const [index, dir] of dirs.entries()) {
    const order = index + 1;
    if (splitPrefix(dir).order === order) continue;
    await renameColumnDir(root, dir, `${order}-${stripPrefix(dir)}`);
    done += 1;
    onStep?.(done, shifted.length);
  }
}
