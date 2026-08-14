import {
  parseFile,
  readNumber,
  readString,
  readTags,
  serializeFile,
  type Frontmatter,
} from './frontmatter';
import { DEFAULT_CONFIG, writeConfig } from './config';
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
  data: Frontmatter;
}

export interface Column {
  dir: string;
  label: string;
  cards: Card[];
}

// Handles are never kept in reactive state; everything is re-resolved by name.
async function columnHandle(root: FileSystemDirectoryHandle, column: string, create = false) {
  return root.getDirectoryHandle(column, { create });
}

function splitPrefix(dir: string): { order: number; label: string } {
  const match = /^(\d+)\s*[-_.]\s*/.exec(dir);
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

  // Close resolves once the write landed, so the clock is as good as a re-stat.
  return Date.now();
}

/** Renumbers a column 1..n, rewriting only the files whose order actually changed. */
export async function persistOrder(
  root: FileSystemDirectoryHandle,
  column: Column,
): Promise<void> {
  for (const [index, card] of column.cards.entries()) {
    const order = index + 1;
    if (card.order === order) continue;

    card.order = order;
    card.data.order = order;
    card.modified = await writeCard(root, card);
  }
}

function slugify(title: string): string {
  // split/join instead of trimming with `-+$`, which backtracks on long dash runs.
  const slug = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 60);

  return slug.replace(/-$/, '') || 'card';
}

async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const base = name.replace(/\.md$/, '');

  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? `${base}.md` : `${base}-${suffix}.md`;
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
  const name = await uniqueName(dir, slugify(title));
  const data: Frontmatter = { title, tags: [], order, created: new Date().toISOString() };
  const modified = await writeCard(root, { column, name, data, body: '' });

  return { ...toCard(column, name, '', modified), title, data, order, modified };
}

const STARTER_COLUMNS = ['1-todo', '2-doing', '3-done'];

const STARTER_CARDS: Array<{ column: string; title: string; body: string }> = [
  {
    column: '1-todo',
    title: 'Drag me to Doing',
    body: [
      'Cards are markdown files. Columns are folders. That is the whole model.',
      '',
      '- Drag between columns to `mv` the file',
      '- Drag to the Archive strip to file it under `archive/YYYY-MM/`',
      '- Double-click the description to edit raw markdown',
    ].join('\n'),
  },
  {
    column: '2-doing',
    title: 'Edit me, then check the file on disk',
    body: [
      'Frontmatter holds the metadata:',
      '',
      '```yaml',
      'title: Edit me, then check the file on disk',
      'tags: [example]',
      'assignee: Brandon',
      '```',
      '',
      'Edits save on a debounce, so your editor and this app can share the folder.',
    ].join('\n'),
  },
];

/** Scaffolds config, columns, an archive dir, and two starter cards into an empty folder. */
export async function initBoard(root: FileSystemDirectoryHandle): Promise<void> {
  await writeConfig(root, { ...DEFAULT_CONFIG });
  for (const dir of STARTER_COLUMNS) await columnHandle(root, dir, true);
  await root.getDirectoryHandle(ARCHIVE_DIR, { create: true });

  for (const card of STARTER_CARDS) {
    const created = await createCard(root, card.column, card.title, 1);
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

  // Only drop the source once the copy is verifiably on disk.
  const written = await (await toDir.getFileHandle(target)).getFile();
  if (written.size !== new Blob([text]).size) {
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

export async function archiveCard(
  root: FileSystemDirectoryHandle,
  card: Pick<Card, 'column' | 'name'>,
): Promise<void> {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const archive = await root.getDirectoryHandle(ARCHIVE_DIR, { create: true });
  const bucket = await archive.getDirectoryHandle(month, { create: true });

  await moveFile(root, card.column, card.name, bucket);
}
