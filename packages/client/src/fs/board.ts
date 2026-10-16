import {
  ensureCardUuid,
  type Frontmatter,
  parseFile,
  readNumber,
  readString,
  readTags,
  serializeFile,
} from '@mdello/common/frontmatter';
import { findReferences } from '../references';
import { type Card, createBoardSettings } from '../types/board.ts';
import { readAttachments } from './attachments';
import { CONFIG_FILE, writeConfig } from './config';
import { openWritable } from './writable';

export const ARCHIVE_DIR = 'archive';

function toCard(
  name: string,
  text: string,
  modified: number,
): { card: Card; uuidCreated: boolean } {
  let { data, body } = parseFile(text);
  body = body.trimStart();
  const { uuid, created: uuidCreated } = ensureCardUuid(data);

  return {
    uuidCreated,
    card: {
      id: uuid,
      uuid,
      name,
      column: readString(data, 'column') ?? '',
      title: readString(data, 'title') ?? name.replace(/\.md$/, ''),
      tags: readTags(data),
      assignee: readString(data, 'assignee'),
      created: readString(data, 'created'),
      order: readNumber(data, 'order'),
      modified,
      body,
      attachments: readAttachments(data),
      references: findReferences(body),
      data,
    },
  };
}

/**
 * Every card in the board root, unsorted and ungrouped. Archive and support directories are
 * never scanned. Layout is the controller's job, so this deliberately returns a flat list.
 */
export async function scanBoard(root: FileSystemDirectoryHandle): Promise<Card[]> {
  const files: FileSystemFileHandle[] = [];

  for await (const entry of root.values()) {
    if (entry.kind === 'file' && entry.name.endsWith('.md')) files.push(entry);
  }

  return Promise.all(
    files.map(async (entry) => {
      const file = await entry.getFile();
      const { card, uuidCreated } = toCard(entry.name, await file.text(), file.lastModified);
      if (uuidCreated) card.modified = await writeCard(root, card.name, card.data, card.body);
      return card;
    }),
  );
}

export async function writeCard(
  root: FileSystemDirectoryHandle,
  name: string,
  data: Frontmatter,
  body: string,
): Promise<number> {
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await openWritable(handle);
  await writable.write(serializeFile(data, body));
  await writable.close();
  return (await handle.getFile()).lastModified;
}

function slugify(title: string, fallback = 'card'): string {
  const slug = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 60);
  return slug.replace(/-$/, '') || fallback;
}

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

export async function createCard(
  root: FileSystemDirectoryHandle,
  column: string,
  title: string,
  order: number,
  body = '',
): Promise<Card> {
  const name = await uniqueName(root, `${slugify(title)}.md`);
  const uuid = crypto.randomUUID();
  const data: Frontmatter = {
    uuid,
    title,
    column,
    tags: [],
    order,
    created: new Date().toISOString(),
  };
  const modified = await writeCard(root, name, data, body);

  return toCard(name, serializeFile(data, body), modified).card;
}

const STARTER_COLUMNS = ['Todo', 'Doing', 'Done'];
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
    column: 'Doing',
    title: 'Edit or Drag Me Around',
    tags: [TUTORIAL_TAG],
    body: [
      'Cards are markdown files in this folder. Their `column` frontmatter places them on the board.',
      '',
      '- Drag between columns to update the frontmatter',
      '- Double-click the description to edit raw markdown',
      '- Press escape to exit and save the file',
      '- Edits also save automatically',
      '',
      'Edit me now to see the file change on disk. Double-click here.',
    ].join('\n'),
  },
  {
    column: 'Doing',
    title: 'Archive this card',
    tags: [TUTORIAL_TAG],
    body: [
      'Archiving takes a card off the board without deleting anything.',
      '',
      '- Drag a card onto the Archive strip at the edge of the board',
      `- The file moves to \`${ARCHIVE_DIR}/YYYY-MM/\`, bucketed by the month you archived it`,
      '- The archive folder is never scanned, so old cards cost nothing',
      '- Nothing is destroyed: move the file back to the board root to restore it',
      '',
      'Try it on this card.',
    ].join('\n'),
  },
  {
    column: 'Todo',
    title: 'Set a background image',
    tags: [SETUP_TAG],
    body: [
      'Drag any image file onto the window. It is saved as `background.<ext>` in this board',
      'folder and drawn centred and cropped to cover.',
      '',
      'Delete the file to go back to the plain board.',
      '',
      'The National Gallery of Art has [some lovely options](https://www.nga.gov/artwork-search?f[]=awtype:107231&f[]=movement:46221&f[]=movement:58341&page=3).',
    ].join('\n'),
  },
  {
    column: 'Todo',
    title: 'Update the config file',
    tags: [SETUP_TAG],
    body: [
      `Board settings live in \`${CONFIG_FILE}\` next to the card files.`,
      '',
      '| Key | What it does |',
      '| --- | --- |',
      '| `columns` | Ordered list of column names. Each card selects one with its `column` frontmatter key. |',
      '| `path` | Absolute path of this folder. Enables each card’s open-in-editor link. |',
      '| `editor` | URL template for that link; `{path}` becomes the card file path. |',
      '| `labels` | Tag names and colours. |',
      '',
      'Hand-edit it any time; mdello re-reads it and keeps the explanatory comments.',
    ].join('\n'),
  },
  {
    column: 'Todo',
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

/** Scaffolds config, archive, and starter cards into an empty folder. */
export async function initBoard(root: FileSystemDirectoryHandle): Promise<void> {
  await writeConfig(
    root,
    createBoardSettings({
      columns: STARTER_COLUMNS,
      labels: [
        { name: SETUP_TAG, color: SETUP_COLOR },
        { name: TUTORIAL_TAG, color: TUTORIAL_COLOR },
      ],
    }),
  );
  await root.getDirectoryHandle(ARCHIVE_DIR, { create: true });

  const orders: Record<string, number> = {};
  for (const card of STARTER_CARDS) {
    const order = (orders[card.column] ?? 0) + 1;
    orders[card.column] = order;
    const created = await createCard(root, card.column, card.title, order);
    created.data.tags = card.tags ?? [];
    await writeCard(root, created.name, created.data, card.body);
  }
}

async function moveFile(
  fromDir: FileSystemDirectoryHandle,
  name: string,
  toDir: FileSystemDirectoryHandle,
): Promise<string> {
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

  if ((await (await (await toDir.getFileHandle(target)).getFile()).text()) !== text) {
    throw new Error(`Copy of ${name} could not be verified; source kept`);
  }
  await fromDir.removeEntry(name);
  return target;
}

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

export async function archiveCard(
  root: FileSystemDirectoryHandle,
  card: Pick<Card, 'name'>,
): Promise<{ dir: string; name: string }> {
  const bucket = await archiveBucket(root);
  return { dir: bucket.dir, name: await moveFile(root, card.name, bucket.handle) };
}

export async function unarchiveCard(
  root: FileSystemDirectoryHandle,
  archived: { dir: string; name: string },
): Promise<string> {
  const [archive, month] = archived.dir.split('/');
  const source = await (await root.getDirectoryHandle(archive)).getDirectoryHandle(month);
  return moveFile(source, archived.name, root);
}
