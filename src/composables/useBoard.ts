import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import {
  archiveCard,
  archiveColumn,
  createCard,
  createColumn,
  initBoard,
  moveCard,
  persistColumnOrder,
  persistOrder,
  renameColumn,
  readColumn,
  scanBoard,
  unarchiveCard,
  writeCard,
  ARCHIVE_DIR,
  type Card,
  type Column,
} from '../fs/board';
import { findReferences } from '../references';
import { showToast } from './useToast';
import { grantPermission, pickBoard, restoreBoard, type BoardAccess } from '../fs/handle';
import { acquireBoardLock, releaseBoardLock } from '../fs/lock';
import { watchBoard } from '../fs/watch';
import { readBackground, writeBackground } from '../fs/background';
import {
  DEFAULT_CONFIG,
  editorName,
  editorUrl,
  readConfig,
  writeConfig,
  CONFIG_FILE,
  type BoardConfig,
} from '../fs/config';
import { labels, takeLegacyLabels } from './useLabels';

const SAVE_DELAY = 600;
const WATCH_DELAY = 250;
const ECHO_WINDOW = 1000;

const access = shallowRef<BoardAccess>({ state: 'none' });
const columns = ref<Column[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const saveState = ref<'idle' | 'dirty' | 'saving' | 'saved'>('idle');
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

const config = ref<BoardConfig>({ ...DEFAULT_CONFIG });
/** Blob URL for `background.<ext>` in the board root, empty when the board has none. */
const background = ref('');

async function loadBackground(): Promise<void> {
  const next = root.value ? await readBackground(root.value) : null;
  if (background.value) URL.revokeObjectURL(background.value);
  background.value = next ?? '';
}
/** Set while the config file is being applied, so loading labels does not write them back. */
let applyingConfig = false;

/** Labels live in the board config, so any edit to them rewrites that file. */
async function loadConfig(): Promise<void> {
  if (!root.value) return;

  const loaded = await readConfig(requireRoot());
  const legacy = loaded.labels.length === 0 ? takeLegacyLabels() : [];
  loaded.labels = legacy.length ? legacy : loaded.labels;

  applyingConfig = true;
  config.value = loaded;
  labels.value = loaded.labels;
  applyingConfig = false;

  if (legacy.length) await saveConfig();
}

async function saveConfig(): Promise<void> {
  if (!root.value) return;
  config.value.labels = [...labels.value];
  lastConfigWrite = Date.now();
  await guard(async () => writeConfig(requireRoot(), config.value));
  lastConfigWrite = Date.now();
}

watch(
  labels,
  () => {
    if (!applyingConfig) void saveConfig();
  },
  { deep: true },
);

/** True while a FileSystemObserver is attached, so callers can skip focus polling. */
const watching = ref(false);
let disconnectWatcher: (() => void) | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;

let lastConfigWrite = 0;
let configChanged = false;
let backgroundChanged = false;
/** Columns touched since the last reload; null means "unknown, rescan the board". */
let dirtyColumns: Set<string> | null = new Set();

function markDirty(column: string | null): void {
  if (dirtyColumns === null) return;
  if (column === null) dirtyColumns = null;
  else dirtyColumns.add(column);
}

/** Observer also reports our own writes, so debounce and skip while saves are pending. */
function onFileChange(records: FileSystemChangeRecord[]): void {
  for (const record of records) {
    const [top, ...rest] = record.relativePathComponents;

    // A record with no path (errored/unknown) could be anything: reload everything.
    if (top === undefined) {
      configChanged = true;
      markDirty(null);
    } else if (top === CONFIG_FILE && rest.length === 0) configChanged = true;
    // OS litter (.DS_Store and friends) is never a card; do not rescan for it.
    else if (record.relativePathComponents.at(-1)?.startsWith('.')) continue;
    else if (rest.length === 0 && /^background\./i.test(top)) backgroundChanged = true;
    else if (top === ARCHIVE_DIR || top.startsWith('.')) continue;
    // A change on a top-level entry is a column appearing or disappearing.
    else markDirty(rest.length === 0 ? null : top);
  }

  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    // Our own config write echoes back as a change; ignore that window.
    if (configChanged && Date.now() - lastConfigWrite > ECHO_WINDOW) void loadConfig();
    configChanged = false;

    if (backgroundChanged) void loadBackground();
    backgroundChanged = false;

    // Keep the dirty set; our own writes land first. Column moves rename folders file by file,
    // so re-scanning mid-flight would blank out columns that are about to reappear.
    if (pendingSaves.size > 0 || busy.value) return;
    const dirty = dirtyColumns;
    dirtyColumns = new Set();
    if (dirty === null) void refresh();
    else if (dirty.size) void refreshColumns([...dirty]);
  }, WATCH_DELAY);
}

function detachWatcher(): void {
  disconnectWatcher?.();
  disconnectWatcher = null;
  watching.value = false;
}

async function attachWatcher(): Promise<void> {
  detachWatcher();
  if (!root.value) return;

  disconnectWatcher = await watchBoard(root.value, onFileChange);
  watching.value = disconnectWatcher !== null;
}

const root = computed(() => (access.value.state === 'ready' ? access.value.handle : null));

/** True when another tab of this browser already has this folder open. */
const locked = ref(false);

/** Takes the folder lock, then loads. A losing tab shows a gate and touches nothing. */
async function openBoard(): Promise<void> {
  locked.value = false;

  if (!root.value) {
    releaseBoardLock();
  } else if (!(await acquireBoardLock(root.value))) {
    locked.value = true;
    detachWatcher();
    columns.value = [];
    return;
  }

  await loadConfig();
  await loadBackground();
  await refresh();
  await attachWatcher();
}

function setAccess(next: BoardAccess): void {
  // Native handles must not be wrapped in a reactive proxy.
  access.value = 'handle' in next ? { ...next, handle: markRaw(next.handle) } : next;
}

function requireRoot(): FileSystemDirectoryHandle {
  if (!root.value) throw new Error('No board folder is open');
  return root.value;
}

async function guard<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    error.value = null;
    return await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    return undefined;
  }
}

/**
 * Reuses card objects that are still on disk, so open modals and in-flight drags keep
 * pointing at live state instead of an orphaned copy.
 */
function mergeCards(current: Card[], fresh: Card[]): Card[] {
  const byId = new Map(current.map((card) => [card.id, card]));

  return fresh.map((next) => {
    const existing = byId.get(next.id);
    if (!existing) return next;
    if (existing.modified !== next.modified) Object.assign(existing, next);
    return existing;
  });
}

/** Column objects are reused too: identity is what `placeCard` compares. */
function mergeColumns(fresh: Column[]): Column[] {
  const byDir = new Map(columns.value.map((column) => [column.dir, column]));

  return fresh.map((next) => {
    const existing = byDir.get(next.dir);
    if (!existing) return next;
    existing.label = next.label;
    existing.cards = mergeCards(existing.cards, next.cards);
    return existing;
  });
}

export async function refresh(): Promise<void> {
  if (!root.value) return;
  loading.value = true;
  await guard(async () => {
    columns.value = mergeColumns(await scanBoard(requireRoot()));
  });
  loading.value = false;
}

/** Re-reads only the columns the watcher flagged; falls back to a full scan on any surprise. */
async function refreshColumns(dirs: string[]): Promise<void> {
  if (!root.value) return;

  const known = new Map(columns.value.map((column) => [column.dir, column]));
  if (dirs.some((dir) => !known.has(dir))) return refresh();

  try {
    const handle = requireRoot();
    const fresh = await Promise.all(dirs.map((dir) => readColumn(handle, dir)));

    for (const next of fresh) {
      const existing = known.get(next.dir)!;
      existing.label = next.label;
      existing.cards = mergeCards(existing.cards, next.cards);
    }
    error.value = null;
  } catch {
    // Column vanished mid-read, or something else moved: re-derive the whole board.
    await refresh();
  }
}

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

/** Renaming a label rewrites loaded cards only; archived files keep the old tag. */
function renameTag(from: string, to: string): void {
  for (const column of columns.value) {
    for (const card of column.cards) {
      if (!card.tags.includes(from)) continue;
      card.tags = [...new Set(card.tags.map((tag) => (tag === from ? to : tag)))];
      queueSave(card);
    }
  }
}

export function useBoard() {
  return {
    access,
    locked,
    watching,
    columns,
    editorName: computed(() => editorName(config.value)),
    rootPath: computed(() => config.value.path),
    background,
    cardUrl: (card: Pick<Card, 'column' | 'name'>) => editorUrl(config.value, card),
    loading,
    error,
    busy,
    saveState,
    boardName: computed(() => ('handle' in access.value ? access.value.handle.name : '')),

    async init(): Promise<void> {
      await guard(async () => setAccess(await restoreBoard()));
      await openBoard();
    },

    async pick(): Promise<void> {
      await guard(async () => setAccess(await pickBoard()));
      await openBoard();
    },

    async grant(): Promise<void> {
      if (access.value.state !== 'needs-permission') return;
      const handle = access.value.handle;
      await guard(async () => setAccess(await grantPermission(handle)));
      await openBoard();
    },

    /** Re-attempt after the other tab closed. */
    retry: openBoard,

    refresh,

    /** Drop target for images: writes background.<ext> into the board root. */
    async setBackground(file: File): Promise<boolean> {
      if (!root.value || locked.value) return false;
      const done = await guard(async () => {
        await writeBackground(requireRoot(), file);
        return true;
      });
      await loadBackground();
      return done === true;
    },

    /** Config + cards, for the manual button and the focus fallback. */
    async reload(): Promise<void> {
      if (locked.value) return;
      await loadConfig();
      await loadBackground();
      await refresh();
    },

    /** Scaffolds a starter board into the currently open (empty) folder. */
    async initialize(): Promise<void> {
      loading.value = true;
      await guard(async () => initBoard(requireRoot()));
      loading.value = false;
      await loadConfig();
      await refresh();
    },

    queueSave,
    renameTag,
    flushCard,

    async addColumn(label: string): Promise<void> {
      await guard(async () => {
        const column = await createColumn(requireRoot(), label, columns.value.length + 1);
        columns.value = [...columns.value, column];
      });
    },

    /** Folder rename moves every card file, so pending card writes go out first. */
    async renameColumn(column: Column, label: string): Promise<void> {
      const next = label.trim();
      if (!next || next === column.label) return;

      await withBusy(`Renaming "${column.label}" to "${next}"…`, async () => {
        await flushPending();
        await guard(async () => renameColumn(requireRoot(), column.dir, next));
      });
    },

    /**
     * Live preview while a column header is dragged: the board reorders under the cursor and
     * nothing touches disk until the drop. Swapping in place keeps the held column under the
     * pointer, so the next dragover is a no-op instead of a fight.
     */
    previewColumnOrder(dir: string, index: number): void {
      const current = columns.value.findIndex((column) => column.dir === dir);
      if (current === -1 || current === index) return;

      columnSnapshot ??= columns.value.map((column) => column.dir);

      const next = [...columns.value];
      const [moved] = next.splice(current, 1);
      next.splice(index, 0, moved);
      columns.value = next;
    },

    /** Cards go to `archive/YYYY-MM/` and the folder goes away. Files stay recoverable. */
    async archiveColumn(column: Column): Promise<void> {
      await withBusy(`Archiving "${column.label}"…`, async () => {
        await flushPending();
        const moved = await guard(async () => archiveColumn(requireRoot(), column.dir));
        if (moved !== undefined) {
          showToast(`Archived "${column.label}" and ${moved} card${moved === 1 ? '' : 's'}`);
        }
      });
    },

    /** Drop: renumber the folder prefixes to match what the user is already looking at. */
    async commitColumnOrder(): Promise<void> {
      const before = columnSnapshot;
      columnSnapshot = null;
      if (!before) return;

      const dirs = columns.value.map((column) => column.dir);
      if (dirs.every((dir, index) => dir === before[index])) return;

      await withBusy('Reordering columns…', async () => {
        await flushPending();
        await guard(async () =>
          persistColumnOrder(requireRoot(), dirs, (done, total) => {
            busy.value = `Reordering columns… ${done} of ${total} folders`;
          }),
        );
      });
    },

    /** Drag cancelled (escape, or dropped outside): put the preview back. */
    cancelColumnOrder(): void {
      const before = columnSnapshot;
      columnSnapshot = null;
      if (!before) return;

      const byDir = new Map(columns.value.map((column) => [column.dir, column]));
      columns.value = before.map((dir) => byDir.get(dir)!).filter(Boolean);
    },

    async addCard(column: Column, title: string): Promise<Card | undefined> {
      return guard(async () => {
        const card = await createCard(requireRoot(), column.dir, title, 1);
        column.cards.unshift(card);
        await persistOrder(requireRoot(), column);
        return card;
      });
    },

    /** Drops a card at an explicit slot, then renumbers that column on disk. */
    async placeCard(card: Card, toColumn: Column, index: number): Promise<void> {
      await flushCard(card);
      const from = columns.value.find((column) => column.dir === card.column);

      if (from === toColumn) {
        const current = toColumn.cards.indexOf(card);
        if (current === -1) return;

        // The slot index counts the dragged card itself, so dropping lower shifts by one.
        const destination = index > current ? index - 1 : index;
        if (destination === current) return;

        toColumn.cards.splice(current, 1);
        toColumn.cards.splice(destination, 0, card);
      } else {
        const moved = await guard(async () => moveCard(requireRoot(), card, toColumn.dir));
        if (moved === undefined) return;

        if (from) from.cards = from.cards.filter((entry) => entry.id !== card.id);
        card.column = toColumn.dir;
        card.name = moved;
        card.id = `${toColumn.dir}/${moved}`;
        toColumn.cards.splice(Math.min(index, toColumn.cards.length), 0, card);
      }

      await guard(async () => persistOrder(requireRoot(), toColumn));
    },

    async archive(card: Card): Promise<void> {
      await flushCard(card);
      const from = columns.value.find((column) => column.dir === card.column);
      const index = from ? from.cards.indexOf(card) : 0;

      const archived = await guard(async () => archiveCard(requireRoot(), card));
      if (archived === undefined) return;

      if (from) from.cards = from.cards.filter((entry) => entry.id !== card.id);

      showToast(`Archived "${card.title}"`, 5000, {
        label: 'Undo',
        run: async () => {
          const name = await guard(async () =>
            unarchiveCard(requireRoot(), archived, card.column),
          );
          if (name === undefined || !from) return;

          card.name = name;
          card.id = `${card.column}/${name}`;
          from.cards.splice(Math.min(index, from.cards.length), 0, card);
          await guard(async () => persistOrder(requireRoot(), from));
        },
      });
    },
  };
}

/** Column order as it was before the current drag started; null when no drag is previewing. */
let columnSnapshot: string[] | null = null;

/** Non-null while a blocking folder operation runs; the string is what the overlay shows. */
const busy = ref<string | null>(null);

/** Held for a beat even on fast boards, so the overlay reads as progress and not a flash. */
const BUSY_MIN = 1000;

/** Blocks the UI and mutes the watcher for the duration of a multi-file folder operation. */
async function withBusy(label: string, action: () => Promise<void>): Promise<void> {
  busy.value = label;
  const started = Date.now();
  try {
    await action();
  } finally {
    const left = BUSY_MIN - (Date.now() - started);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    busy.value = null;
    // Whatever the watcher swallowed while blocked is picked up by this one scan.
    await refresh();
  }
}

/** Column folder ops move files out from under queued card writes; drain them first. */
async function flushPending(): Promise<void> {
  for (const column of columns.value) {
    for (const card of column.cards) await flushCard(card);
  }
}

async function flushCard(card: Card): Promise<void> {
  const timer = pendingSaves.get(card.id);
  if (timer !== undefined) clearTimeout(timer);
  if (!pendingSaves.delete(card.id)) return;

  saveState.value = 'saving';
  card.references = findReferences(card.body);
  const modified = await guard(async () => {
    card.data.title = card.title;
    // An empty assignee drops the key rather than writing `assignee: ''`.
    card.assignee = card.assignee?.trim() || undefined;
    if (card.assignee) card.data.assignee = card.assignee;
    else delete card.data.assignee;
    // Avoid adding an empty `tags:` key to files that never had one.
    if (card.tags.length || 'tags' in card.data) card.data.tags = [...card.tags];
    return writeCard(root.value!, card);
  });

  if (modified !== undefined) card.modified = modified;
  saveState.value = error.value ? 'idle' : 'saved';
}
