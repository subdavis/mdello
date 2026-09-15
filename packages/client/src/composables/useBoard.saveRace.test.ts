import assert from 'node:assert/strict';
import { after, default as test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { Card } from '../fs/board.ts';
import type { useBoard as useBoardType } from './useBoard.ts';

const server = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
});
const { useBoard } = (await server.ssrLoadModule('/src/composables/useBoard.ts')) as {
  useBoard: typeof useBoardType;
};
after(() => server.close());

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function card(body: string): Card {
  return {
    id: 'card-id',
    uuid: 'card-id',
    name: 'race.md',
    column: 'Todo',
    title: 'Race',
    tags: [],
    modified: 0,
    body,
    attachments: [],
    references: [],
    data: {},
  };
}

test('an edit arriving during a write is persisted after the active write', async () => {
  const board = useBoard();
  const firstWriteStarted = deferred();
  const releaseFirstWrite = deferred();
  let locked = false;
  let writeCount = 0;
  let persisted = '';

  const fileHandle = {
    name: 'race.md',
    kind: 'file',
    async createWritable() {
      if (locked) throw new DOMException('File is already locked', 'NoModificationAllowedError');
      locked = true;
      let content = '';
      return {
        async write(next: string) {
          content = next;
          writeCount += 1;
          if (writeCount === 1) firstWriteStarted.resolve();
        },
        async close() {
          if (writeCount === 1) await releaseFirstWrite.promise;
          persisted = content;
          locked = false;
        },
      };
    },
    async getFile() {
      return { lastModified: Date.now() };
    },
  };
  const root = {
    name: 'board',
    kind: 'directory',
    async getFileHandle() {
      return fileHandle;
    },
  };

  board.access.value = {
    state: 'ready',
    id: 'test-board',
    handle: root as unknown as FileSystemDirectoryHandle,
  };
  board.error.value = null;

  const current = card('first version');
  board.queueSave(current);
  const firstFlush = board.flushCard(current);
  await firstWriteStarted.promise;

  current.body = 'second version';
  board.queueSave(current);
  const secondFlush = board.flushCard(current);
  // Keep the first stream locked beyond openWritable's retry window. A concurrent second write
  // fails; a queued second write waits without touching the handle.
  await new Promise((resolve) => setTimeout(resolve, 75));
  releaseFirstWrite.resolve();
  await Promise.all([firstFlush, secondFlush]);

  assert.match(persisted, /second version/);
  assert.equal(board.error.value, null);
});

test('finishing an older write does not report saved while a newer edit is pending', async () => {
  const board = useBoard();
  const firstWriteStarted = deferred();
  const releaseFirstWrite = deferred();
  let content = '';

  const fileHandle = {
    name: 'race.md',
    kind: 'file',
    async createWritable() {
      return {
        async write(next: string) {
          content = next;
          firstWriteStarted.resolve();
        },
        async close() {
          await releaseFirstWrite.promise;
        },
      };
    },
    async getFile() {
      return { lastModified: Date.now() };
    },
  };
  const root = {
    name: 'board',
    kind: 'directory',
    async getFileHandle() {
      return fileHandle;
    },
  };

  board.access.value = {
    state: 'ready',
    id: 'test-board',
    handle: root as unknown as FileSystemDirectoryHandle,
  };
  board.error.value = null;

  const current = card('first version');
  board.queueSave(current);
  const firstFlush = board.flushCard(current);
  await firstWriteStarted.promise;

  current.body = 'second version';
  board.queueSave(current);
  releaseFirstWrite.resolve();
  await firstFlush;

  const stateAfterOlderWrite = board.saveState.value;
  await board.flushCard(current);

  assert.match(content, /second version/);
  assert.equal(stateAfterOlderWrite, 'dirty');
});
