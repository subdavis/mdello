import { ensureCardUuid, parseFile, serializeFile } from '@mdello/common/frontmatter';
import { readConfig, writeConfig } from '../fs/config.ts';
import { openWritable } from '../fs/writable.ts';

const RESERVED_DIRECTORIES = new Set(['archive', 'attachments']);
const PREFIX = /^(\d+)\s*[-_.]\s*/;

interface LegacyColumn {
  dir: string;
  label: string;
  order: number;
  handle: FileSystemDirectoryHandle;
  cards: FileSystemFileHandle[];
}

function columnName(dir: string): { label: string; order: number } {
  const match = PREFIX.exec(dir);
  const plain = (match ? dir.slice(match[0].length) : dir)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return {
    label: plain || dir,
    order: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
  };
}

async function legacyColumns(
  root: FileSystemDirectoryHandle,
  hasConfiguredColumns: boolean,
): Promise<LegacyColumn[]> {
  const columns: LegacyColumn[] = [];

  for await (const entry of root.values()) {
    if (
      entry.kind !== 'directory' ||
      entry.name.startsWith('.') ||
      RESERVED_DIRECTORIES.has(entry.name)
    ) {
      continue;
    }

    const cards: FileSystemFileHandle[] = [];
    for await (const child of entry.values()) {
      if (child.kind === 'file' && child.name.endsWith('.md')) cards.push(child);
    }
    if (hasConfiguredColumns && cards.length === 0) continue;

    const { label, order } = columnName(entry.name);
    columns.push({ dir: entry.name, label, order, handle: entry, cards });
  }

  columns.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  return columns;
}

function assignColumnNames(columns: LegacyColumn[], configured: string[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set(configured);

  for (const column of columns) {
    if (configured.includes(column.label)) {
      assigned.set(column.dir, column.label);
      continue;
    }

    let name = column.label;
    let suffix = 2;
    while (used.has(name)) {
      name = `${column.label} ${suffix}`;
      suffix += 1;
    }
    used.add(name);
    assigned.set(column.dir, name);
  }
  return assigned;
}

async function targetName(
  root: FileSystemDirectoryHandle,
  sourceName: string,
  content: string,
): Promise<{ name: string; exists: boolean }> {
  const match = /^(.+)(\.[^.]+)$/.exec(sourceName);
  const base = match?.[1] ?? sourceName;
  const extension = match?.[2] ?? '';

  for (let suffix = 0; ; suffix += 1) {
    const name = suffix === 0 ? sourceName : `${base}-${suffix}${extension}`;
    try {
      const existing = await root.getFileHandle(name);
      if ((await (await existing.getFile()).text()) === content) return { name, exists: true };
    } catch {
      return { name, exists: false };
    }
  }
}

async function writeMigratedCard(
  root: FileSystemDirectoryHandle,
  column: LegacyColumn,
  card: FileSystemFileHandle,
  columnName: string,
): Promise<void> {
  const source = await card.getFile();
  const { data, body } = parseFile(await source.text());
  ensureCardUuid(data);
  data.column = columnName;
  const content = serializeFile(data, body);

  // Persist generated identity in source first. If migration is interrupted, retry finds same
  // content instead of minting another UUID and creating a duplicate root card.
  const sourceWritable = await openWritable(card);
  await sourceWritable.write(content);
  await sourceWritable.close();
  if ((await (await card.getFile()).text()) !== content) {
    throw new Error(`Migration update of ${card.name} could not be verified; source kept`);
  }

  const target = await targetName(root, card.name, content);
  if (!target.exists) {
    const handle = await root.getFileHandle(target.name, { create: true });
    const writable = await openWritable(handle);
    await writable.write(content);
    await writable.close();
    if ((await (await handle.getFile()).text()) !== content) {
      throw new Error(`Migration copy of ${card.name} could not be verified; source kept`);
    }
  }

  await column.handle.removeEntry(card.name);
}

async function removeEmptyDirectory(
  root: FileSystemDirectoryHandle,
  column: LegacyColumn,
): Promise<void> {
  const first = await column.handle.values().next();
  if (first.done) await root.removeEntry(column.dir);
}

async function runColumnMigration(
  root: FileSystemDirectoryHandle,
  confirmMigration: (message: string) => boolean,
): Promise<boolean> {
  const config = await readConfig(root);
  const columns = await legacyColumns(root, config.columns.length > 0);
  if (columns.length === 0) return false;

  const cardCount = columns.reduce((total, column) => total + column.cards.length, 0);
  if (cardCount === 0) return false;

  const accepted = confirmMigration(
    `Mdello found ${columns.length} folder column${columns.length === 1 ? '' : 's'} containing ${cardCount} card${cardCount === 1 ? '' : 's'}. Migrate them to the new flat board format now?`,
  );
  if (!accepted) return false;

  const names = assignColumnNames(columns, config.columns);
  const configured = [...config.columns];
  for (const column of columns) {
    const name = names.get(column.dir);
    if (name && !configured.includes(name)) configured.push(name);
  }
  await writeConfig(root, { ...config, columns: configured });

  for (const column of columns) {
    const name = names.get(column.dir);
    if (!name) continue;
    for (const card of column.cards) await writeMigratedCard(root, column, card, name);
    await removeEmptyDirectory(root, column);
  }
  return true;
}

const activeMigrations = new WeakMap<FileSystemDirectoryHandle, Promise<boolean>>();

/**
 * Temporary, self-contained migration from folder columns to flat cards. Remove this module and
 * its single call site once legacy boards no longer need support.
 */
export function promptForColumnMigration(
  root: FileSystemDirectoryHandle,
  confirmMigration: (message: string) => boolean = (message) => window.confirm(message),
): Promise<boolean> {
  const active = activeMigrations.get(root);
  if (active) return active;

  const migration = runColumnMigration(root, confirmMigration).finally(() => {
    if (activeMigrations.get(root) === migration) activeMigrations.delete(root);
  });
  activeMigrations.set(root, migration);
  return migration;
}
