import assert from 'node:assert/strict';
import { after, default as test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { useBoard as useBoardType } from '../composables/useBoard.ts';
import type { Card, Column } from '../types/board.ts';
import type { BoardStore } from './store.ts';
import type { MemoryBoardStore as MemoryBoardStoreType } from './stores/memoryBoardStore.ts';

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
const { toast, dismissToast } = (await server.ssrLoadModule('/src/composables/useToast.ts')) as {
  toast: { value: { action?: { run: () => Promise<void> } } | null };
  dismissToast: () => void;
};

/** One Todo column with two cards, plus a card in a column the settings do not know about. */
function seed(): MemoryBoardStoreType {
  return new MemoryBoardStore({
    settings: {
      columns: ['Todo', 'Doing'],
      labels: [{ name: 'Bug', color: '#f87168' }],
    },
    cards: [
      { title: 'One', column: 'Todo', order: 1, tags: ['Bug'] },
      { title: 'Two', column: 'Todo', order: 2 },
      { title: 'Stray', column: 'Ghost', order: 1 },
    ],
  });
}

/** Counts writes so debounce and skip-if-unchanged behaviour can be asserted directly. */
function recording(store: BoardStore): BoardStore & { saves: string[] } {
  const saves: string[] = [];
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'saves') return saves;
      const value = Reflect.get(target, property, receiver);
      if (property !== 'saveCard') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (card: Card) => {
        saves.push(card.uuid);
        return (value as BoardStore['saveCard']).call(target, card);
      };
    },
  }) as BoardStore & { saves: string[] };
}

async function open(store: BoardStore = seed()) {
  await openBoardStore(store);
  return useBoard();
}

/** Fails the nth `saveCard` onwards, to exercise partially-applied multi-card operations. */
function failingAfter(store: BoardStore, successes: number): BoardStore {
  let seen = 0;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'saveCard') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (card: Card) => {
        seen += 1;
        if (seen > successes) throw new Error('disk is on fire');
        return (value as BoardStore['saveCard']).call(target, card);
      };
    },
  });
}

function column(board: ReturnType<typeof useBoard>, name: string): Column {
  const found = board.columns.value.find((entry: Column) => entry.name === name);
  assert.ok(found, `expected a column named ${name}`);
  return found;
}

test('groups a flat card list into configured and virtual columns', async () => {
  const board = await open();

  assert.deepEqual(
    board.columns.value.map((entry: Column) => ({ name: entry.name, virtual: entry.virtual })),
    [
      { name: 'Ghost', virtual: true },
      { name: 'Todo', virtual: false },
      { name: 'Doing', virtual: false },
    ],
  );
  assert.deepEqual(
    column(board, 'Todo').cards.map((card: Card) => card.title),
    ['One', 'Two'],
  );
});

test('rejects a duplicate column name without touching storage', async () => {
  const store = seed();
  const board = await open(store);

  await board.addColumn('Todo');

  assert.equal(board.error.value, 'Column "Todo" already exists');
  assert.deepEqual((await store.load()).settings.columns, ['Todo', 'Doing']);
});

test('renaming a column rewrites its cards and persists the new order', async () => {
  const store = seed();
  const board = await open(store);

  await board.renameColumn(column(board, 'Todo'), '  Later  ');

  assert.equal(board.error.value, null);
  const snapshot = await store.load();
  assert.deepEqual(snapshot.settings.columns, ['Later', 'Doing']);
  assert.deepEqual(
    snapshot.cards
      .filter((card) => card.column === 'Later')
      .map((card) => card.title)
      .sort(),
    ['One', 'Two'],
  );
});

test('a rename that fails part way through leaves no card stranded', async () => {
  // Two cards in Todo; the first write lands, the second does not.
  const store = failingAfter(seed(), 1);
  const board = await open(store);

  await board.renameColumn(column(board, 'Todo'), 'Later');

  assert.equal(board.error.value, 'disk is on fire');
  // Whatever the column ended up called, no card may claim a column that is not on the board.
  const names = new Set(board.columns.value.map((entry: Column) => entry.name));
  for (const entry of board.columns.value) {
    for (const card of entry.cards) {
      assert.ok(names.has(card.column), `card "${card.title}" claims missing column`);
      assert.equal(card.column, entry.name, `card "${card.title}" is in the wrong column`);
    }
  }
});

test('renaming a column onto an existing name is refused', async () => {
  const board = await open();

  await board.renameColumn(column(board, 'Todo'), 'Doing');

  assert.equal(board.error.value, 'Column "Doing" already exists');
  assert.ok(board.columns.value.some((entry: Column) => entry.name === 'Todo'));
});

test('committing a drag promotes a virtual column into settings', async () => {
  const store = seed();
  const board = await open(store);

  await board.commitColumnOrder('Ghost');

  assert.deepEqual((await store.load()).settings.columns, ['Ghost', 'Todo', 'Doing']);
  assert.equal(column(board, 'Ghost').virtual, false);
});

test('moving a card between columns renumbers both sides', async () => {
  const store = recording(seed());
  const board = await open(store);
  const todo = column(board, 'Todo');
  const doing = column(board, 'Doing');
  const card = todo.cards[0];

  await board.placeCard(card, doing, 0);

  assert.deepEqual(
    todo.cards.map((entry: Card) => entry.title),
    ['Two'],
  );
  assert.equal(card.column, 'Doing');
  assert.equal(card.order, 1);
  // 'Two' moves from order 2 to 1, and the moved card gets order 1 in its new column.
  assert.equal(store.saves.length, 2);

  const persisted = (await store.load()).cards.find((entry) => entry.uuid === card.uuid);
  assert.equal(persisted?.column, 'Doing');
});

test('reordering within a column writes only the cards that actually moved', async () => {
  const store = recording(seed());
  const board = await open(store);
  const todo = column(board, 'Todo');

  await board.placeCard(todo.cards[1], todo, 0);

  assert.deepEqual(
    todo.cards.map((entry: Card) => entry.title),
    ['Two', 'One'],
  );
  assert.equal(store.saves.length, 2);
});

test('renaming a tag queues one save per affected card and leaves others alone', async () => {
  const store = recording(seed());
  const board = await open(store);
  const tagged = column(board, 'Todo').cards[0];

  board.renameTag('Bug', 'Defect');
  assert.deepEqual(tagged.tags, ['Defect']);

  await board.flushCard(tagged);
  assert.deepEqual(store.saves, [tagged.uuid]);
});

test('a label edit writes settings and renames the tag on loaded cards', async () => {
  const store = seed();
  const board = await open(store);
  const tagged = column(board, 'Todo').cards[0];

  assert.equal(await board.updateLabel(0, { name: 'Defect', color: '#f87168' }), true);
  board.renameTag('Bug', 'Defect');
  await board.flushCard(tagged);

  const snapshot = await store.load();
  assert.deepEqual(snapshot.settings.labels, [{ name: 'Defect', color: '#f87168' }]);
  assert.deepEqual(snapshot.cards.find((card) => card.uuid === tagged.uuid)?.tags, ['Defect']);
});

test('archiving removes the card, and undo puts it back where it was', async () => {
  const store = seed();
  const board = await open(store);
  const todo = column(board, 'Todo');
  const card = todo.cards[1];

  await board.archive(card);

  assert.deepEqual(
    todo.cards.map((entry: Card) => entry.title),
    ['One'],
  );
  assert.equal(
    (await store.load()).cards.some((entry) => entry.uuid === card.uuid),
    false,
  );

  const action = toast.value?.action;
  assert.ok(action, 'archiving should offer an undo');
  await action.run();
  dismissToast();

  assert.deepEqual(
    todo.cards.map((entry: Card) => entry.title),
    ['One', 'Two'],
  );
  assert.equal(
    (await store.load()).cards.some((entry) => entry.uuid === card.uuid),
    true,
  );
});

test('repeated edits inside the debounce window collapse into a single write', async () => {
  const store = recording(seed());
  const board = await open(store);
  const card = column(board, 'Todo').cards[0];

  card.body = 'first';
  board.queueSave(card);
  card.body = 'second';
  board.queueSave(card);
  card.body = 'third';
  await board.flushCard(card);

  assert.deepEqual(store.saves, [card.uuid]);
  assert.equal((await store.load()).cards.find((e) => e.uuid === card.uuid)?.body, 'third');
});

test('a reload keeps card identity and does not overwrite a pending edit', async () => {
  const store = seed();
  const board = await open(store);
  const todo = column(board, 'Todo');
  const [first, second] = todo.cards;

  // An external change to one card, while the other has an unsaved edit in memory. The card
  // is deproxied first: a store is contractually handed plain data, never reactive state.
  await store.saveCard({
    ...(JSON.parse(JSON.stringify(first)) as Card),
    title: 'Renamed elsewhere',
  });
  second.body = 'local edit';
  board.queueSave(second);

  await board.refresh();

  const reloaded = column(board, 'Todo');
  assert.equal(reloaded.cards[0], first, 'card objects must be reused across a reload');
  assert.equal(first.title, 'Renamed elsewhere');
  assert.equal(second.body, 'local edit', 'a pending save must win over a stale read');

  await board.flushCard(second);
});

test('closing a board drains pending writes and clears every trace of it', async () => {
  const store = recording(seed());
  const board = await open(store);
  const card = column(board, 'Todo').cards[0];

  card.body = 'written on the way out';
  board.queueSave(card);

  await open(seed());

  assert.deepEqual(store.saves, [card.uuid]);
  assert.equal(board.error.value, null);
  assert.equal(board.saveState.value, 'idle');
});
