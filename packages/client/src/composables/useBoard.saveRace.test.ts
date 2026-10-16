import assert from 'node:assert/strict';
import { after, default as test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { BoardStore } from '../board/store.ts';
import type { MemoryBoardStore as MemoryBoardStoreType } from '../board/stores/memoryBoardStore.ts';
import type { Card } from '../types/board.ts';
import type { useBoard as useBoardType } from './useBoard.ts';

const server = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
});
after(() => server.close());

const { useBoard, openBoardStore } = (await server.ssrLoadModule(
  '/src/composables/useBoard.ts',
)) as {
  useBoard: typeof useBoardType;
  openBoardStore: (store: BoardStore) => Promise<void>;
};
const { MemoryBoardStore } = (await server.ssrLoadModule(
  '/src/board/stores/memoryBoardStore.ts',
)) as { MemoryBoardStore: typeof MemoryBoardStoreType };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Holds the first write open until released, and fails loudly if a second one starts while
 * it is still in flight. That is exactly the guarantee the controller's per-card write chain
 * is supposed to provide, and testing it needs nothing more than a slow store.
 */
function stalling(store: BoardStore, release: Promise<void>) {
  const started = deferred();
  let writes = 0;
  let inFlight = false;

  // A Proxy rather than Object.create: the store keeps private fields, so its methods only
  // work when they run with the real instance as `this`.
  const wrapper = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'saveCard') {
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return async (card: Readonly<Card>) => {
        if (inFlight) throw new Error('two writes for one card overlapped');
        inFlight = true;
        writes += 1;
        if (writes === 1) {
          started.resolve();
          await release;
        }
        try {
          return await (value as BoardStore['saveCard']).call(target, card);
        } finally {
          inFlight = false;
        }
      };
    },
  });

  return { store: wrapper, started: started.promise, writes: () => writes };
}

function seed(): MemoryBoardStoreType {
  return new MemoryBoardStore({
    settings: { columns: ['Todo'] },
    cards: [{ title: 'Race', column: 'Todo', order: 1, body: 'first version' }],
  });
}

test('an edit arriving during a write is persisted after the active write', async () => {
  const backing = seed();
  const release = deferred();
  const slow = stalling(backing, release.promise);

  await openBoardStore(slow.store);
  const board = useBoard();
  const card = board.columns.value[0].cards[0];

  card.body = 'first version';
  board.queueSave(card);
  const firstFlush = board.flushCard(card);
  await slow.started;

  card.body = 'second version';
  board.queueSave(card);
  const secondFlush = board.flushCard(card);

  release.resolve();
  await Promise.all([firstFlush, secondFlush]);

  const persisted = (await backing.load()).cards[0];
  assert.match(persisted.body, /second version/);
  assert.equal(slow.writes(), 2);
  assert.equal(board.error.value, null);
});

test('finishing an older write does not report saved while a newer edit is pending', async () => {
  const backing = seed();
  const release = deferred();
  const slow = stalling(backing, release.promise);

  await openBoardStore(slow.store);
  const board = useBoard();
  const card = board.columns.value[0].cards[0];

  card.body = 'first version';
  board.queueSave(card);
  const firstFlush = board.flushCard(card);
  await slow.started;

  card.body = 'second version';
  board.queueSave(card);
  release.resolve();
  await firstFlush;

  const stateAfterOlderWrite = board.saveState.value;
  await board.flushCard(card);

  assert.match((await backing.load()).cards[0].body, /second version/);
  assert.equal(stateAfterOlderWrite, 'dirty');
});
