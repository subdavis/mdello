import assert from 'node:assert/strict';
import { after, default as test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { Card } from '../../types/board.ts';
import type { BoardStore } from '../store.ts';
import type { FileSystemBoardStore as FileSystemBoardStoreType } from './fileSystemBoardStore.ts';
import type { MemoryBoardStore as MemoryBoardStoreType } from './memoryBoardStore.ts';

/**
 * One suite, both backends. Every case here is a promise the `BoardStore` interface makes, so
 * a divergence between memory and disk shows up as a failure rather than as a demo that
 * behaves subtly differently from the real app.
 *
 * Loaded through Vite rather than plain node because `scanBoard` reaches `references.ts`,
 * which imports SVG assets that only a bundler can resolve.
 */
const server = await createServer({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
});
after(() => server.close());

const { MemoryBoardStore } = (await server.ssrLoadModule(
  '/src/board/stores/memoryBoardStore.ts',
)) as { MemoryBoardStore: typeof MemoryBoardStoreType };
const { FileSystemBoardStore } = (await server.ssrLoadModule(
  '/src/board/stores/fileSystemBoardStore.ts',
)) as { FileSystemBoardStore: typeof FileSystemBoardStoreType };

// ---------------------------------------------------------------------------
// A directory handle good enough for the `fs/*` modules
// ---------------------------------------------------------------------------

/** Strictly increasing, because a real file cannot be written twice in the same instant. */
let clock = 0;
function tick(): number {
  clock = Math.max(Date.now(), clock + 1);
  return clock;
}

function missing(name: string): Error {
  const error = new Error(`${name} was not found`);
  error.name = 'NotFoundError';
  return error;
}

/**
 * The subset of the File System Access API that `fs/attachments`, `fs/background`,
 * `fs/board` and `fs/config` actually reach for. Notably absent: `FileSystemFileHandle.move`,
 * which is optional in Chrome too — leaving it off drives `moveFile` down its copy-verify-delete
 * path, which is the branch worth testing.
 */
function fakeDirectory(name = 'demo-board') {
  const files = new Map<string, { blob: Blob; lastModified: number }>();
  const directories = new Map<string, ReturnType<typeof fakeDirectory>>();

  function fileHandle(entry: string) {
    return {
      kind: 'file' as const,
      name: entry,
      async getFile(): Promise<File> {
        const stored = files.get(entry);
        if (!stored) throw missing(entry);
        return new File([stored.blob], entry, { lastModified: stored.lastModified });
      },
      async createWritable() {
        const chunks: BlobPart[] = [];
        return {
          async write(chunk: BlobPart): Promise<void> {
            chunks.push(chunk);
          },
          async close(): Promise<void> {
            files.set(entry, { blob: new Blob(chunks), lastModified: tick() });
          },
        };
      },
    };
  }

  const directory = {
    kind: 'directory' as const,
    name,

    async getFileHandle(entry: string, options?: { create?: boolean }) {
      if (!files.has(entry)) {
        if (!options?.create) throw missing(entry);
        files.set(entry, { blob: new Blob([]), lastModified: tick() });
      }
      return fileHandle(entry);
    },

    async getDirectoryHandle(entry: string, options?: { create?: boolean }) {
      const existing = directories.get(entry);
      if (existing) return existing;
      if (!options?.create) throw missing(entry);
      const created = fakeDirectory(entry);
      directories.set(entry, created);
      return created;
    },

    async removeEntry(entry: string): Promise<void> {
      if (!files.delete(entry) && !directories.delete(entry)) throw missing(entry);
    },

    /** Yields live handles, not descriptors: callers read `kind`/`name` and then `getFile()`. */
    async *values() {
      for (const entry of [...files.keys()]) yield fileHandle(entry);
      for (const entry of [...directories.values()]) yield entry;
    },
  };

  return directory;
}

function fileSystemStore(): BoardStore {
  const root = fakeDirectory() as unknown as FileSystemDirectoryHandle;
  return new FileSystemBoardStore('fake', root);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const BACKENDS: Array<[string, () => BoardStore]> = [
  ['MemoryBoardStore', () => new MemoryBoardStore()],
  ['FileSystemBoardStore', fileSystemStore],
];

/** Both backends start empty, so every fixture below is built through the interface itself. */
async function seeded(store: BoardStore): Promise<Card> {
  const settings = (await store.load()).settings;
  await store.saveSettings({ ...settings, columns: ['Todo', 'Doing'] });
  return store.createCard({ title: 'First card', column: 'Todo', order: 1, body: 'Hello' });
}

function find(cards: Card[], uuid: string): Card {
  const card = cards.find((entry) => entry.uuid === uuid);
  assert.ok(card, `expected a card with uuid ${uuid}`);
  return card;
}

for (const [backend, create] of BACKENDS) {
  test(`${backend}: an empty board loads with usable settings`, async () => {
    const snapshot = await create().load();

    assert.ok(snapshot.settings.uuid, 'every board must identify itself');
    assert.deepEqual(snapshot.cards, []);
  });

  test(`${backend}: settings and cards survive a round trip`, async () => {
    const store = create();
    const card = await seeded(store);

    const snapshot = await store.load();
    assert.deepEqual(snapshot.settings.columns, ['Todo', 'Doing']);

    const loaded = find(snapshot.cards, card.uuid);
    assert.equal(loaded.title, 'First card');
    assert.equal(loaded.column, 'Todo');
    assert.equal(loaded.order, 1);
    assert.equal(loaded.body.trim(), 'Hello');
  });

  test(`${backend}: cards with the same title get distinct names`, async () => {
    const store = create();
    await seeded(store);
    const twin = await store.createCard({
      title: 'First card',
      column: 'Todo',
      order: 2,
      body: '',
    });

    const names = (await store.load()).cards.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length, `names collided: ${names.join(', ')}`);
    assert.notEqual(twin.name, '');
  });

  test(`${backend}: saveCard preserves keys the app does not own`, async () => {
    const store = create();
    const card = await seeded(store);

    const { modified } = await store.saveCard({
      ...card,
      title: 'Renamed',
      tags: ['Bug'],
      data: { ...card.data, sprint: 42 },
    });
    assert.ok(modified >= card.modified, 'a write must not move the clock backwards');

    const loaded = find((await store.load()).cards, card.uuid);
    assert.equal(loaded.title, 'Renamed');
    assert.deepEqual(loaded.tags, ['Bug']);
    assert.equal(loaded.data.sprint, 42);
  });

  test(`${backend}: archiving hides a card and restoring brings it back`, async () => {
    const store = create();
    const card = await seeded(store);

    const token = await store.archiveCard(card);
    assert.equal(
      (await store.load()).cards.some((entry) => entry.uuid === card.uuid),
      false,
    );

    const restored = await store.restoreCard(token);
    assert.ok(restored.name, 'a restored card must come back under some name');
    assert.equal(find((await store.load()).cards, card.uuid).title, 'First card');
  });

  test(`${backend}: attachments write, read back, and delete`, async () => {
    const store = create();

    const attachment = await store.writeAttachment(
      new File(['notes'], 'note.txt', { type: 'text/plain' }),
    );
    assert.equal(attachment.name, 'note.txt');
    assert.equal(attachment.type, 'text/plain');
    assert.equal(await (await store.readAttachment(attachment)).text(), 'notes');

    await store.deleteAttachment(attachment);
    await assert.rejects(() => store.readAttachment(attachment));
  });

  test(`${backend}: the wallpaper round trips, and is absent until written`, async () => {
    const store = create();
    assert.equal(await store.readBackground(), null);

    await store.writeBackground(new File(['pixels'], 'wall.png', { type: 'image/png' }));

    const blob = await store.readBackground();
    assert.ok(blob, 'the wallpaper must be readable after it is written');
    assert.equal(await blob.text(), 'pixels');
  });

  test(`${backend}: watch reports whether it can watch, and close is safe`, async () => {
    const store = create();

    // Neither backend can watch here: memory has nothing to observe, and node has no
    // FileSystemObserver. Both must say so with null rather than a disposer that does nothing.
    assert.equal(await store.watch(() => undefined), null);
    await store.close();
  });
}
