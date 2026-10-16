import { computed, ref, shallowRef, toRaw } from 'vue';
import { archiveWithSessionAssociations } from '../archiveAssociations';
import { buildColumns } from '../board/columns';
import { editorName, editorUrl } from '../board/editor';
import type { BoardStore, StorageInvalidation } from '../board/store';
import { parseMarkdownImport } from '../importMarkdown';
import { findReferences } from '../references';
import {
  type ArchiveToken,
  type BoardSettings,
  type Card,
  type CardAttachment,
  type Column,
  DEFAULT_EDITOR,
  type Label,
} from '../types/board';
import { expungeCardAssociations, fetchCardAssociations } from './useCompanion';
import { showToast } from './useToast';

const SAVE_DELAY = 600;
const WATCH_DELAY = 250;

/** The open backend. Everything below persists through this and nothing else. */
const store = shallowRef<BoardStore | null>(null);

const columns = ref<Column[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const saveState = ref<'idle' | 'dirty' | 'saving' | 'saved'>('idle');
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
/** Tail of each card's write chain. A card never has two writes in flight concurrently. */
const inFlightSaves = new Map<string, Promise<void>>();

/** Board settings, including labels. There is no other copy of them anywhere. */
const settings = ref<BoardSettings | null>(null);
/** Object URL for the wallpaper blob the store handed us; empty when the board has none. */
const background = ref('');

/** True while a live change watcher is attached, so callers can skip focus polling. */
const watching = ref(false);

let disconnectWatcher: (() => void) | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
let staleBoard = false;
let staleBackground = false;

/** Column order as it was before the current drag started; null when no drag is previewing. */
let columnSnapshot: string[] | null = null;

/**
 * Board labels, which live in settings and nowhere else. Exported as one shared computed so
 * per-tag styling in a render loop reads it rather than building a new one every call.
 */
export const labels = computed<readonly Label[]>(() => settings.value?.labels ?? []);

/**
 * Hoisted rather than rebuilt per `useBoard()` call, because the filesystem shell watches them
 * from module scope to keep its board registry in step with whatever board is loaded.
 */
export const rootPath = computed(() => settings.value?.path ?? '');
export const configReady = computed(() => settings.value !== null);

function requireStore(): BoardStore {
  if (!store.value) throw new Error('No board is open');
  return store.value;
}

function requireSettings(): BoardSettings {
  if (!settings.value) throw new Error('Board settings have not loaded');
  return settings.value;
}

/**
 * Runs an action, routing any failure to the one shared error banner. Exported so the
 * filesystem shell reports picker and permission failures the same way board rules do.
 */
export async function guard<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    error.value = null;
    return await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    return undefined;
  }
}

/**
 * A plain, fully detached copy for the store to serialize. Cloning here is what lets
 * `saveCard` take a `Readonly<Card>`: storage can never observe a later edit mid-write,
 * and the controller never has to mutate a card just to get it written.
 */
function cardSnapshot(card: Card): Card {
  return structuredClone(toRaw(card));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Reuses card objects that are still present, so open modals and in-flight drags keep
 * pointing at live state instead of an orphaned copy.
 */
function mergeCards(current: Card[], fresh: Card[]): Card[] {
  const byId = new Map(current.map((card) => [card.id, card]));

  return fresh.map((next) => {
    const existing = byId.get(next.id);
    if (!existing) return next;
    // A queued or in-flight save means memory is ahead of storage; never merge backwards.
    if (pendingSaves.has(next.id) || inFlightSaves.has(next.id)) return existing;
    if (existing.modified !== next.modified) Object.assign(existing, next);
    return existing;
  });
}

/** Column objects are reused too: identity is what `placeCard` compares. */
function mergeColumns(fresh: Column[]): Column[] {
  const byName = new Map(columns.value.map((column) => [column.name, column]));

  return fresh.map((next) => {
    const existing = byName.get(next.name);
    if (!existing) return next;
    existing.cards = mergeCards(existing.cards, next.cards);
    existing.virtual = next.virtual;
    return existing;
  });
}

/** Settings and cards in one read. Grouping and sorting happen here, for every backend. */
async function loadSnapshot(): Promise<void> {
  const current = store.value;
  if (!current) return;

  loading.value = true;
  await guard(async () => {
    const snapshot = await current.load();
    settings.value = snapshot.settings;
    columns.value = mergeColumns(buildColumns(snapshot.cards, snapshot.settings.columns));
  });
  loading.value = false;
}

async function loadBackground(): Promise<void> {
  const blob = store.value ? await store.value.readBackground() : null;
  const next = blob ? URL.createObjectURL(blob) : '';
  if (background.value) URL.revokeObjectURL(background.value);
  background.value = next;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Throws. Use inside an existing `guard`, so one failure reports one message. */
async function writeSettings(): Promise<void> {
  // Detached for the same reason card writes are: storage must not observe a later edit
  // landing between the call and the moment it actually serializes.
  await requireStore().saveSettings(structuredClone(toRaw(requireSettings())));
}

async function persistSettings(): Promise<boolean> {
  if (!store.value || !settings.value) return false;
  const saved = await guard(async () => {
    await writeSettings();
    return true;
  });
  return saved === true;
}

/** Every label edit is a settings write, so they all go through one rollback-on-failure path. */
async function editLabels(mutate: (labels: Label[]) => void): Promise<boolean> {
  const current = settings.value;
  if (!current) return false;

  const previous = current.labels;
  const next = current.labels.map((label) => ({ ...label }));
  mutate(next);
  current.labels = next;

  if (await persistSettings()) return true;
  current.labels = previous;
  return false;
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

/**
 * The store says what went stale; deciding what to re-read is ours. Coalesced, because a
 * single user-visible change can produce a burst of events.
 */
function onInvalidate(change: StorageInvalidation): void {
  if (change === 'background' || change === 'all') staleBackground = true;
  if (change !== 'background') staleBoard = true;
  armWatchTimer();
}

function armWatchTimer(): void {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    void drainInvalidations();
  }, WATCH_DELAY);
}

async function drainInvalidations(): Promise<void> {
  if (staleBackground) {
    staleBackground = false;
    await loadBackground();
  }
  if (!staleBoard) return;

  // Our own writes are already suppressed by the store, so a pending save will not produce
  // another event to retry on. Re-arm instead of dropping the reload on the floor.
  if (pendingSaves.size > 0 || inFlightSaves.size > 0) {
    armWatchTimer();
    return;
  }

  staleBoard = false;
  await loadSnapshot();
}

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

async function openStore(next: BoardStore): Promise<void> {
  store.value = next;
  await loadSnapshot();
  await loadBackground();

  disconnectWatcher = await next.watch(onInvalidate);
  watching.value = disconnectWatcher !== null;
}

/** Everything `openStore` set up, undone, so the next board starts from a clean slate. */
async function closeStore(): Promise<void> {
  // Queued card writes resolve their store at flush time, so anything still pending when the
  // store changes would land in the board we are switching *to*. Drain first.
  await flushPending();

  disconnectWatcher?.();
  disconnectWatcher = null;
  watching.value = false;
  clearTimeout(watchTimer);
  staleBoard = false;
  staleBackground = false;

  const current = store.value;
  store.value = null;
  await current?.close();

  if (background.value) URL.revokeObjectURL(background.value);
  background.value = '';
  columns.value = [];
  settings.value = null;
  columnSnapshot = null;
  saveState.value = 'idle';
  error.value = null;
}

// ---------------------------------------------------------------------------
// Card writes
// ---------------------------------------------------------------------------

/** Debounced write. Card object is mutated first so the UI stays immediate. */
function queueSave(card: Card): void {
  saveState.value = 'dirty';
  clearTimeout(pendingSaves.get(card.id));
  pendingSaves.set(
    card.id,
    setTimeout(() => {
      void flushCard(card);
    }, SAVE_DELAY),
  );
}

function flushCard(card: Card): Promise<void> {
  const timer = pendingSaves.get(card.id);
  if (timer !== undefined) clearTimeout(timer);

  const previous = inFlightSaves.get(card.id);
  if (!pendingSaves.delete(card.id)) return previous ?? Promise.resolve();

  // Domain normalization, not serialization: an empty assignee is no assignee, and the
  // reference chips are derived from the body once per save rather than per keystroke.
  card.references = findReferences(card.body);
  card.assignee = card.assignee?.trim() || undefined;

  const current = requireStore();
  const snapshot = cardSnapshot(card);

  saveState.value = 'saving';
  const operation = (previous ?? Promise.resolve()).then(async () => {
    const result = await guard(async () => current.saveCard(snapshot));
    if (result !== undefined) card.modified = result.modified;
  });
  inFlightSaves.set(card.id, operation);

  void operation.finally(() => {
    if (inFlightSaves.get(card.id) !== operation) return;
    inFlightSaves.delete(card.id);
    if (inFlightSaves.size > 0) saveState.value = 'saving';
    else if (pendingSaves.size > 0) saveState.value = 'dirty';
    else saveState.value = error.value ? 'idle' : 'saved';
  });

  return operation;
}

/** Drain debounced writes before board switches or bulk column changes. */
async function flushPending(): Promise<void> {
  for (const column of columns.value) {
    for (const card of column.cards) await flushCard(card);
  }
}

/** Renumbers a column 1..n, writing only the cards whose position actually changed. */
async function renumber(column: Column): Promise<void> {
  const current = requireStore();
  for (const [index, card] of column.cards.entries()) {
    const order = index + 1;
    if (card.order === order) continue;
    card.order = order;
    const { modified } = await current.saveCard(cardSnapshot(card));
    card.modified = modified;
  }
}

/** Archives one card, first folding any live companion sessions into its metadata. */
async function archiveOne(card: Card): Promise<ArchiveToken> {
  const current = requireStore();
  const loaded = requireSettings();
  if (!loaded.companion) return current.archiveCard(cardSnapshot(card));

  const live = await fetchCardAssociations(loaded.uuid, card.uuid);
  return archiveWithSessionAssociations(card.data, live, {
    persist: async () => {
      const { modified } = await current.saveCard(cardSnapshot(card));
      card.modified = modified;
    },
    expunge: () => expungeCardAssociations(card.uuid),
    move: () => current.archiveCard(cardSnapshot(card)),
  });
}

/** Renaming a label rewrites loaded cards only; archived cards keep the old tag. */
function renameTag(from: string, to: string): void {
  for (const column of columns.value) {
    for (const card of column.cards) {
      if (!card.tags.includes(from)) continue;
      card.tags = [...new Set(card.tags.map((tag) => (tag === from ? to : tag)))];
      queueSave(card);
    }
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function configuredColumnNames(): string[] {
  return columns.value.filter((column) => !column.virtual).map((column) => column.name);
}

/** Virtual columns always lead the UI but never enter settings until promoted. */
function normalizeColumnOrder(): void {
  columns.value = [
    ...columns.value.filter((column) => column.virtual),
    ...columns.value.filter((column) => !column.virtual),
  ];
}

export function useBoard() {
  return {
    watching,
    columns,
    labels,
    editorName: computed(() => editorName(settings.value ?? { editor: DEFAULT_EDITOR })),
    editorTemplate: computed(() => settings.value?.editor ?? DEFAULT_EDITOR),
    rootPath,
    boardUuid: computed(() => settings.value?.uuid ?? ''),
    configReady,
    companionEnabled: computed(() => settings.value?.companion ?? false),
    background,
    cardUrl: (card: Pick<Card, 'name'>) =>
      settings.value ? editorUrl(settings.value, card) : undefined,
    loading,
    error,
    saveState,
    /** Whatever backend is open names the board. Empty between boards. */
    boardName: computed(() => store.value?.name ?? ''),

    refresh: loadSnapshot,

    /** Drop target for images. */
    async setBackground(file: File): Promise<boolean> {
      if (!store.value) return false;
      const done = await guard(async () => {
        await requireStore().writeBackground(file);
        return true;
      });
      await loadBackground();
      return done === true;
    },

    async setCompanionEnabled(enabled: boolean): Promise<void> {
      const loaded = settings.value;
      if (!store.value || !loaded || loaded.companion === enabled) return;
      const previous = loaded.companion;
      loaded.companion = enabled;
      if (!(await persistSettings())) loaded.companion = previous;
    },

    /**
     * The two settings the dialog owns. A blank editor means "the default", not "no editor",
     * because an empty template would silently break every card link.
     */
    async saveSettings(next: { path: string; editor: string }): Promise<boolean> {
      const loaded = settings.value;
      if (!store.value || !loaded) return false;

      const path = next.path.trim();
      const editor = next.editor.trim() || DEFAULT_EDITOR;
      if (loaded.path === path && loaded.editor === editor) return true;

      const previous = { path: loaded.path, editor: loaded.editor };
      loaded.path = path;
      loaded.editor = editor;
      if (!(await persistSettings())) {
        Object.assign(loaded, previous);
        return false;
      }
      return true;
    },

    addLabel: (label: Label) => editLabels((entries) => entries.push({ ...label })),
    updateLabel: (index: number, label: Label) =>
      editLabels((entries) => {
        entries[index] = { ...label };
      }),
    removeLabel: (index: number) =>
      editLabels((entries) => {
        entries.splice(index, 1);
      }),

    /** Settings + cards + wallpaper, for the manual button and the focus fallback. */
    async reload(): Promise<void> {
      if (!store.value) return;
      await loadSnapshot();
      await loadBackground();
    },

    /** Scaffolds a starter board into the currently open (empty) board. */
    async initialize(): Promise<void> {
      if (!store.value) return;
      loading.value = true;
      await guard(async () => requireStore().scaffold());
      loading.value = false;
      await loadSnapshot();
    },

    queueSave,
    renameTag,
    flushCard,

    async addAttachments(card: Card, files: File[]): Promise<number> {
      if (!files.length || !store.value) return 0;
      const current = requireStore();
      const added = await guard(async () =>
        Promise.all(files.map((file) => current.writeAttachment(file))),
      );
      if (!added) return 0;

      card.attachments.push(...added);
      queueSave(card);
      await flushCard(card);
      return added.length;
    },

    async attachmentFile(attachment: CardAttachment): Promise<File | undefined> {
      return guard(async () => requireStore().readAttachment(attachment));
    },

    async removeAttachment(card: Card, attachment: CardAttachment): Promise<boolean> {
      const index = card.attachments.findIndex((entry) => entry.file === attachment.file);
      if (index === -1) return false;

      const previous = [...card.attachments];
      card.attachments.splice(index, 1);

      queueSave(card);
      await flushCard(card);
      if (error.value) {
        card.attachments.splice(0, card.attachments.length, ...previous);
        return false;
      }

      await guard(async () => requireStore().deleteAttachment(attachment));
      return true;
    },

    async addColumn(label: string): Promise<void> {
      const name = label.trim();
      if (!name) return;
      await guard(async () => {
        if (columns.value.some((column) => column.name === name)) {
          throw new Error(`Column "${name}" already exists`);
        }
        columns.value = [...columns.value, { name, cards: [], virtual: false }];
        requireSettings().columns = configuredColumnNames();
        await writeSettings();
      });
    },

    /** Renaming changes settings plus affected cards; card identities stay stable. */
    async renameColumn(column: Column, label: string): Promise<void> {
      const next = label.trim();
      if (!next || next === column.name) return;
      if (columns.value.some((entry) => entry !== column && entry.name === next)) {
        error.value = `Column "${next}" already exists`;
        return;
      }

      await flushPending();
      const previous = column.name;
      const wasVirtual = column.virtual;
      const touched: Card[] = [];
      const done = await guard(async () => {
        const current = requireStore();
        column.name = next;
        column.virtual = false;
        normalizeColumnOrder();
        for (const card of column.cards) {
          card.column = next;
          touched.push(card);
          const { modified } = await current.saveCard(cardSnapshot(card));
          card.modified = modified;
        }
        requireSettings().columns = configuredColumnNames();
        await writeSettings();
        return true;
      });
      if (done) return;

      // Restoring the header is not enough: every card the loop reached is already claiming
      // the new name in memory, and a card whose write never landed has an unchanged
      // `modified`, so the reload below would skip right over it.
      column.name = previous;
      column.virtual = wasVirtual;
      for (const card of touched) card.column = previous;
      normalizeColumnOrder();

      // An unknown number of cards did reach storage before it failed, and only storage
      // knows which. Re-read so the board shows what is actually on disk — those cards
      // reappear under the new name as a virtual column rather than vanishing.
      const failure = error.value;
      await loadSnapshot();
      // loadSnapshot clears the error on its way in; the rename failure is what to report.
      error.value = failure;
    },

    /** Live preview while a column header is dragged; settings change only on drop. */
    previewColumnOrder(name: string, index: number): void {
      const current = columns.value.findIndex((column) => column.name === name);
      if (current === -1 || current === index) return;
      columnSnapshot ??= columns.value.map((column) => column.name);

      const next = [...columns.value];
      const [moved] = next.splice(current, 1);
      next.splice(index, 0, moved);
      columns.value = next;
    },

    /** Archives every card, then removes the column from settings. */
    async archiveColumn(column: Column): Promise<void> {
      await flushPending();
      const moved = column.cards.length;
      const done = await guard(async () => {
        for (const card of column.cards) await archiveOne(card);
        columns.value = columns.value.filter((entry) => entry !== column);
        requireSettings().columns = configuredColumnNames();
        await writeSettings();
        return true;
      });
      if (done) showToast(`Archived "${column.name}" and ${moved} card${moved === 1 ? '' : 's'}`);
      else await loadSnapshot();
    },

    async commitColumnOrder(movedName: string): Promise<void> {
      columnSnapshot = null;
      const moved = columns.value.find((column) => column.name === movedName);
      const promoted = moved?.virtual === true;
      if (moved) moved.virtual = false;
      normalizeColumnOrder();

      const names = configuredColumnNames();
      const configured = requireSettings().columns;
      const unchanged =
        names.length === configured.length &&
        names.every((name, index) => name === configured[index]);
      if (!promoted && unchanged) return;
      requireSettings().columns = names;
      await persistSettings();
    },

    /** Drag cancelled (escape, or dropped outside): put the preview back. */
    cancelColumnOrder(): void {
      const before = columnSnapshot;
      columnSnapshot = null;
      if (!before) return;
      const byName = new Map(columns.value.map((column) => [column.name, column]));
      columns.value = before.flatMap((name) => {
        const column = byName.get(name);
        return column ? [column] : [];
      });
    },

    async addCard(column: Column, title: string): Promise<Card | undefined> {
      return guard(async () => {
        const card = await requireStore().createCard({
          title,
          column: column.name,
          order: 1,
          body: '',
        });
        column.cards.unshift(card);
        await renumber(column);
        return card;
      });
    },

    async importCard(column: Column, file: File, index: number): Promise<Card | undefined> {
      return guard(async () => {
        const { title, body } = parseMarkdownImport(file.name, await file.text());
        const destination = Math.min(index, column.cards.length);
        const card = await requireStore().createCard({
          title,
          column: column.name,
          order: destination + 1,
          body,
        });
        column.cards.splice(destination, 0, card);
        await renumber(column);
        return card;
      });
    },

    /** Drops a card at an explicit slot, then persists the affected columns' ordering. */
    async placeCard(card: Card, toColumn: Column, index: number): Promise<void> {
      await flushCard(card);
      const from = columns.value.find((column) => column.name === card.column);

      if (from === toColumn) {
        const current = toColumn.cards.indexOf(card);
        if (current === -1) return;
        const destination = index > current ? index - 1 : index;
        if (destination === current) return;
        toColumn.cards.splice(current, 1);
        toColumn.cards.splice(destination, 0, card);
      } else {
        if (from) from.cards = from.cards.filter((entry) => entry.id !== card.id);
        card.column = toColumn.name;
        card.order = undefined;
        toColumn.cards.splice(Math.min(index, toColumn.cards.length), 0, card);
      }

      await guard(async () => {
        if (from && from !== toColumn) await renumber(from);
        await renumber(toColumn);
      });
    },

    async archive(card: Card): Promise<void> {
      await flushCard(card);
      const from = columns.value.find((column) => column.name === card.column);
      const index = from ? from.cards.indexOf(card) : 0;
      const token = await guard(async () => archiveOne(card));
      if (token === undefined) return;
      if (from) from.cards = from.cards.filter((entry) => entry.id !== card.id);

      showToast(`Archived "${card.title}"`, 5000, {
        label: 'Undo',
        run: async () => {
          const restored = await guard(async () => requireStore().restoreCard(token));
          if (restored === undefined || !from) return;
          card.name = restored.name;
          if (restored.modified !== undefined) card.modified = restored.modified;
          from.cards.splice(Math.min(index, from.cards.length), 0, card);
          await guard(async () => renumber(from));
        },
      });
    },
  };
}

/**
 * Attaches a backend to the shared controller, replacing whatever was open.
 * `useFilesystemBoards()` calls this with a `FileSystemBoardStore`; the marketing entry calls
 * it with a `MemoryBoardStore` and mounts the same UI. Controller tests use it to skip both.
 */
export async function openBoardStore(next: BoardStore): Promise<void> {
  await closeStore();
  await openStore(next);
}

/** Detaches the current backend, leaving the controller with no board at all. */
export async function closeBoardStore(): Promise<void> {
  await closeStore();
}
