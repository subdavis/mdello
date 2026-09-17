import { computed, markRaw, ref, shallowRef, toRaw, watch } from 'vue';
import { archiveWithSessionAssociations } from '../archiveAssociations';
import {
  ATTACHMENTS_DIR,
  type CardAttachment,
  deleteAttachment,
  readAttachment,
  writeAttachment,
} from '../fs/attachments';
import { readBackground, writeBackground } from '../fs/background';
import {
  ARCHIVE_DIR,
  archiveCard,
  type Card,
  type Column,
  createCard,
  initBoard,
  persistOrder,
  scanBoard,
  unarchiveCard,
  writeCard,
} from '../fs/board';
import {
  type BoardConfig,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  editorName,
  editorUrl,
  ensureBoardUuid,
  readConfig,
  writeConfig,
} from '../fs/config';
import {
  type BoardAccess,
  type BoardRef,
  forgetBoard,
  grantPermission,
  listBoards,
  noteBoardPath,
  pickBoard,
  restoreBoard,
  selectBoard,
} from '../fs/handle';
import { acquireBoardLock, releaseBoardLock } from '../fs/lock';
import { changePaths, watchBoard } from '../fs/watch';
import { parseMarkdownImport } from '../importMarkdown';
import { promptForColumnMigration } from '../migrations/folderColumns';
import { findReferences } from '../references';
import { expungeCardAssociations, fetchCardAssociations } from './useCompanion';
import { labels, takeLegacyLabels } from './useLabels';
import { showToast } from './useToast';

const SAVE_DELAY = 600;
const WATCH_DELAY = 250;
const ECHO_WINDOW = 1000;

const access = shallowRef<BoardAccess>({ state: 'none' });
/** Shallow: the entries hold native directory handles, which must not be proxied. */
const boards = shallowRef<BoardRef[]>([]);
const columns = ref<Column[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const saveState = ref<'idle' | 'dirty' | 'saving' | 'saved'>('idle');
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
/** Tail of each card's write chain. A card never has two writable streams open concurrently. */
const inFlightSaves = new Map<string, Promise<void>>();

const config = ref<BoardConfig | null>(null);
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
  const identityCreated = ensureBoardUuid(loaded);
  const legacy = loaded.labels.length === 0 ? takeLegacyLabels() : [];
  loaded.labels = legacy.length ? legacy : loaded.labels;

  applyingConfig = true;
  config.value = loaded;
  labels.value = loaded.labels;
  applyingConfig = false;

  // The switcher lists boards by path where it can: every board folder is called `content`.
  const id = activeId.value;
  if (id && (await noteBoardPath(id, loaded.path))) await refreshBoards();

  if (legacy.length || identityCreated) await saveConfig();
}

async function refreshBoards(): Promise<void> {
  boards.value = await listBoards();
}

async function saveConfig(): Promise<boolean> {
  if (!root.value || !config.value) return false;
  const loaded = config.value;
  loaded.labels = [...labels.value];
  lastConfigWrite = Date.now();
  const saved = await guard(async () => {
    await writeConfig(requireRoot(), loaded);
    return true;
  });
  lastConfigWrite = Date.now();
  return saved === true;
}

// flush: 'sync' is load-bearing, not a tuning choice. The default pre-flush runs the
// callback after loadConfig has already cleared `applyingConfig`, so every load — including
// the one the file watcher fires after you hand-edit mdello.yml — wrote the config straight
// back, dropping unknown keys and your comments. Firing inside the mutation keeps the guard
// a real critical section. Trade-off: writes no longer coalesce per tick, which is free only
// while every mutation site touches `labels` exactly once. Bind a control to a live label
// (v-model="labels[i].color") and this becomes a write per keystroke; batch there instead.
watch(
  labels,
  () => {
    if (!applyingConfig) void saveConfig();
  },
  { deep: true, flush: 'sync' },
);

/** True while a FileSystemObserver is attached, so callers can skip focus polling. */
const watching = ref(false);
let disconnectWatcher: (() => void) | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;

let lastConfigWrite = 0;
let configChanged = false;
let backgroundChanged = false;
let cardsChanged = false;

/** Observer also reports our own writes, so debounce and scan the cheap flat card list once. */
function onFileChange(records: FileSystemChangeRecord[]): void {
  for (const record of records) {
    for (const path of changePaths(record)) {
      const [top, ...rest] = path;
      if (top === undefined) {
        configChanged = true;
        backgroundChanged = true;
        cardsChanged = true;
      } else if (top === CONFIG_FILE && rest.length === 0) configChanged = true;
      else if (rest.length === 0 && /^background\./i.test(top)) backgroundChanged = true;
      else if (rest.length === 0 && top.endsWith('.md') && !top.startsWith('.'))
        cardsChanged = true;
      else if (top === ARCHIVE_DIR || top === ATTACHMENTS_DIR || top.startsWith('.')) continue;
    }
  }

  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    void (async () => {
      const externalConfig = configChanged && Date.now() - lastConfigWrite > ECHO_WINDOW;
      configChanged = false;
      if (externalConfig) {
        await loadConfig();
        cardsChanged = true;
      }
      if (backgroundChanged) await loadBackground();
      backgroundChanged = false;
      if (pendingSaves.size > 0 || inFlightSaves.size > 0) return;
      if (cardsChanged) {
        cardsChanged = false;
        await refresh();
      }
    })();
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

/** Registry id of the board being shown, including one still waiting on permission. */
const activeId = computed(() => ('id' in access.value ? access.value.id : null));

/** True when another tab of this browser already has this folder open. */
const locked = ref(false);

/** Takes the folder lock, then loads. A losing tab shows a gate and touches nothing. */
async function openBoard(): Promise<void> {
  locked.value = false;
  const current = access.value;

  if (current.state !== 'ready') {
    releaseBoardLock();
  } else if (!(await acquireBoardLock(current.id))) {
    locked.value = true;
    detachWatcher();
    columns.value = [];
    return;
  }

  const migration = await guard(async () => promptForColumnMigration(requireRoot()));
  if (migration === undefined) return;

  await loadConfig();
  await loadBackground();
  await refresh();
  await attachWatcher();
}

/** Everything `openBoard` set up, undone, so the next board starts from a clean slate. */
async function closeBoard(): Promise<void> {
  // Queued card writes resolve their folder through `root` at flush time, so anything still
  // pending when the root changes lands in the board we are switching *to*. Drain first.
  await flushPending();
  detachWatcher();
  releaseBoardLock();
  clearTimeout(watchTimer);

  if (background.value) URL.revokeObjectURL(background.value);
  background.value = '';
  columns.value = [];
  config.value = null;

  // The guard is what makes clearing labels safe: their watcher is flush:'sync', so it runs
  // inside this assignment and would otherwise write the empty list straight back into the
  // board being left. Clearing matters because openBoard can bail before loadConfig replaces
  // them — a board locked by another tab keeps a live root with the previous board's labels.
  applyingConfig = true;
  labels.value = [];
  applyingConfig = false;

  configChanged = false;
  backgroundChanged = false;
  cardsChanged = false;
  lastConfigWrite = 0;
  columnSnapshot = null;
  saveState.value = 'idle';
  error.value = null;
}

async function switchBoard(id: string): Promise<void> {
  if (id === activeId.value) return;

  // Permission is settled before the teardown: requestPermission needs the user gesture that
  // opened the switcher, and flushing the old board's writes can outlive it.
  const next = await guard(async () => selectBoard(id));
  if (!next) return;

  const opened =
    next.state === 'needs-permission'
      ? ((await guard(async () => grantPermission(next.id, next.handle))) ?? next)
      : next;

  await closeBoard();
  setAccess(opened);
  await openBoard();
  await refreshBoards();
}

function setAccess(next: BoardAccess): void {
  // Native handles must not be wrapped in a reactive proxy.
  access.value = 'handle' in next ? { ...next, handle: markRaw(next.handle) } : next;
}

function requireRoot(): FileSystemDirectoryHandle {
  if (!root.value) throw new Error('No board folder is open');
  return root.value;
}

function requireConfig(): BoardConfig {
  if (!config.value) throw new Error('Board config has not loaded');
  return config.value;
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
    // A queued or in-flight save means memory is ahead of disk; never merge backwards.
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

function configuredColumnNames(): string[] {
  return columns.value.filter((column) => !column.virtual).map((column) => column.name);
}

/** Virtual columns always lead the UI but never enter config until promoted. */
function normalizeColumnOrder(): void {
  columns.value = [
    ...columns.value.filter((column) => column.virtual),
    ...columns.value.filter((column) => !column.virtual),
  ];
}

export async function refresh(): Promise<void> {
  if (!root.value || !config.value) return;
  const loaded = config.value;
  loading.value = true;
  await guard(async () => {
    columns.value = mergeColumns(await scanBoard(requireRoot(), loaded.columns));
  });
  loading.value = false;
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

/** Archives one card, first folding any live companion sessions into its frontmatter. */
async function archiveOne(card: Card): Promise<{ dir: string; name: string }> {
  const loaded = requireConfig();
  if (!loaded.companion) return archiveCard(requireRoot(), card);

  const current = await fetchCardAssociations(loaded.uuid, card.uuid);
  return archiveWithSessionAssociations(card.data, current, {
    persist: async () => {
      card.modified = await writeCard(requireRoot(), card);
    },
    expunge: () => expungeCardAssociations(card.uuid),
    move: () => archiveCard(requireRoot(), card),
  });
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
    boards,
    activeId,
    locked,
    watching,
    columns,
    editorName: computed(() => editorName(config.value ?? DEFAULT_CONFIG)),
    editorTemplate: computed(() => config.value?.editor ?? DEFAULT_CONFIG.editor),
    rootPath: computed(() => config.value?.path ?? ''),
    boardUuid: computed(() => config.value?.uuid ?? ''),
    configReady: computed(() => config.value !== null),
    companionEnabled: computed(() => config.value?.companion ?? false),
    background,
    cardUrl: (card: Pick<Card, 'name'>) =>
      config.value ? editorUrl(config.value, card) : undefined,
    loading,
    error,
    saveState,
    boardName: computed(() => ('handle' in access.value ? access.value.handle.name : '')),

    async init(): Promise<void> {
      await guard(async () => setAccess(await restoreBoard()));
      await refreshBoards();
      await openBoard();
    },

    /** Adds a folder to the registry and opens it; re-picking a known board just switches. */
    async pick(): Promise<void> {
      const picked = await guard(async () => pickBoard());
      // Cancelling the picker leaves the current board alone.
      if (!picked) return;
      if (picked.state === 'unsupported') {
        setAccess(picked);
        return;
      }
      if (picked.state === 'ready' && picked.id === activeId.value) return;

      await closeBoard();
      setAccess(picked);
      await refreshBoards();
      await openBoard();
    },

    async grant(): Promise<void> {
      if (access.value.state !== 'needs-permission') return;
      const { id, handle } = access.value;
      await guard(async () => setAccess(await grantPermission(id, handle)));
      await openBoard();
    },

    switchBoard,

    /** Drops a board from the switcher. Files are untouched; re-pick the folder to get it back. */
    async forgetBoard(id: string): Promise<void> {
      await guard(async () => forgetBoard(id));
      await refreshBoards();
      if (id !== activeId.value) return;

      await closeBoard();
      await guard(async () => setAccess(await restoreBoard()));
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

    async setCompanionEnabled(enabled: boolean): Promise<void> {
      const loaded = config.value;
      if (!root.value || locked.value || !loaded || loaded.companion === enabled) return;
      const previous = loaded.companion;
      loaded.companion = enabled;
      if (!(await saveConfig())) loaded.companion = previous;
    },

    /**
     * The two config scalars the settings dialog owns. A blank editor means "the default",
     * not "no editor", because an empty template would silently break every card link.
     */
    async saveSettings(next: { path: string; editor: string }): Promise<boolean> {
      const loaded = config.value;
      if (!root.value || locked.value || !loaded) return false;

      const path = next.path.trim();
      const editor = next.editor.trim() || DEFAULT_CONFIG.editor;
      if (loaded.path === path && loaded.editor === editor) return true;

      const previous = { path: loaded.path, editor: loaded.editor };
      loaded.path = path;
      loaded.editor = editor;
      if (!(await saveConfig())) {
        Object.assign(loaded, previous);
        return false;
      }

      // The switcher lists boards by path, so the registry has to learn the new one too.
      const id = activeId.value;
      if (id && (await noteBoardPath(id, path))) await refreshBoards();
      return true;
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
      if (!root.value || !config.value) return;
      loading.value = true;
      await guard(async () => initBoard(requireRoot()));
      loading.value = false;
      await loadConfig();
      await refresh();
    },

    queueSave,
    renameTag,
    flushCard,

    async addAttachments(card: Card, files: File[]): Promise<number> {
      if (!files.length || !root.value || locked.value) return 0;
      const added = await guard(async () =>
        Promise.all(files.map((file) => writeAttachment(requireRoot(), file))),
      );
      if (!added) return 0;

      card.attachments.push(...added);
      card.data.attachments = card.attachments.map((attachment) => ({ ...attachment }));
      queueSave(card);
      await flushCard(card);
      return added.length;
    },

    async attachmentFile(attachment: CardAttachment): Promise<File | undefined> {
      return guard(async () => readAttachment(requireRoot(), attachment));
    },

    async removeAttachment(card: Card, attachment: CardAttachment): Promise<boolean> {
      const index = card.attachments.findIndex((entry) => entry.file === attachment.file);
      if (index === -1) return false;

      const previous = [...card.attachments];
      card.attachments.splice(index, 1);
      if (card.attachments.length) {
        card.data.attachments = card.attachments.map((entry) => ({ ...entry }));
      } else {
        delete card.data.attachments;
      }

      queueSave(card);
      await flushCard(card);
      if (error.value) {
        card.attachments.splice(0, card.attachments.length, ...previous);
        card.data.attachments = previous.map((entry) => ({ ...entry }));
        return false;
      }

      await guard(async () => deleteAttachment(requireRoot(), attachment));
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
        requireConfig().columns = configuredColumnNames();
        await saveConfig();
      });
    },

    /** Renaming changes config plus affected cards; filenames stay stable. */
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
      const done = await guard(async () => {
        column.name = next;
        column.virtual = false;
        normalizeColumnOrder();
        for (const card of column.cards) {
          card.column = next;
          card.modified = await writeCard(requireRoot(), card);
        }
        requireConfig().columns = configuredColumnNames();
        await saveConfig();
        return true;
      });
      if (!done) {
        column.name = previous;
        column.virtual = wasVirtual;
        normalizeColumnOrder();
      }
    },

    /** Live preview while a column header is dragged; config changes only on drop. */
    previewColumnOrder(name: string, index: number): void {
      const current = columns.value.findIndex((column) => column.name === name);
      if (current === -1 || current === index) return;
      columnSnapshot ??= columns.value.map((column) => column.name);

      const next = [...columns.value];
      const [moved] = next.splice(current, 1);
      next.splice(index, 0, moved);
      columns.value = next;
    },

    /** Archives every card, then removes column from config. */
    async archiveColumn(column: Column): Promise<void> {
      await flushPending();
      const moved = column.cards.length;
      const done = await guard(async () => {
        for (const card of column.cards) await archiveOne(card);
        columns.value = columns.value.filter((entry) => entry !== column);
        requireConfig().columns = configuredColumnNames();
        await saveConfig();
        return true;
      });
      if (done) showToast(`Archived "${column.name}" and ${moved} card${moved === 1 ? '' : 's'}`);
      else await refresh();
    },

    async commitColumnOrder(movedName: string): Promise<void> {
      columnSnapshot = null;
      const moved = columns.value.find((column) => column.name === movedName);
      const promoted = moved?.virtual === true;
      if (moved) moved.virtual = false;
      normalizeColumnOrder();

      const names = configuredColumnNames();
      const configured = requireConfig().columns;
      const unchanged =
        names.length === configured.length &&
        names.every((name, index) => name === configured[index]);
      if (!promoted && unchanged) return;
      requireConfig().columns = names;
      await saveConfig();
    },

    /** Drag cancelled (escape, or dropped outside): put preview back. */
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
        const card = await createCard(requireRoot(), column.name, title, 1);
        column.cards.unshift(card);
        await persistOrder(requireRoot(), column);
        return card;
      });
    },

    async importCard(column: Column, file: File, index: number): Promise<Card | undefined> {
      return guard(async () => {
        const { title, body } = parseMarkdownImport(file.name, await file.text());
        const destination = Math.min(index, column.cards.length);
        const card = await createCard(requireRoot(), column.name, title, destination + 1, body);
        column.cards.splice(destination, 0, card);
        await persistOrder(requireRoot(), column);
        return card;
      });
    },

    /** Drops a card at an explicit slot, then persists frontmatter and ordering. */
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
        if (from && from !== toColumn) await persistOrder(requireRoot(), from);
        await persistOrder(requireRoot(), toColumn);
      });
    },

    async archive(card: Card): Promise<void> {
      await flushCard(card);
      const from = columns.value.find((column) => column.name === card.column);
      const index = from ? from.cards.indexOf(card) : 0;
      const archived = await guard(async () => archiveOne(card));
      if (archived === undefined) return;
      if (from) from.cards = from.cards.filter((entry) => entry.id !== card.id);

      showToast(`Archived "${card.title}"`, 5000, {
        label: 'Undo',
        run: async () => {
          const name = await guard(async () => unarchiveCard(requireRoot(), archived));
          if (name === undefined || !from) return;
          card.name = name;
          from.cards.splice(Math.min(index, from.cards.length), 0, card);
          await guard(async () => persistOrder(requireRoot(), from));
        },
      });
    },
  };
}

/** Column order as it was before the current drag started; null when no drag is previewing. */
let columnSnapshot: string[] | null = null;

/** Drain debounced writes before board switches or bulk column changes. */
async function flushPending(): Promise<void> {
  for (const column of columns.value) {
    for (const card of column.cards) await flushCard(card);
  }
}

function flushCard(card: Card): Promise<void> {
  const timer = pendingSaves.get(card.id);
  if (timer !== undefined) clearTimeout(timer);

  const previous = inFlightSaves.get(card.id);
  if (!pendingSaves.delete(card.id)) return previous ?? Promise.resolve();

  card.references = findReferences(card.body);
  card.data.title = card.title;
  // An empty assignee drops the key rather than writing `assignee: ''`.
  card.assignee = card.assignee?.trim() || undefined;
  if (card.assignee) card.data.assignee = card.assignee;
  else delete card.data.assignee;
  // Avoid adding an empty `tags:` key to files that never had one.
  if (card.tags.length || 'tags' in card.data) card.data.tags = [...card.tags];

  const root = requireRoot();
  const snapshot = {
    column: card.column,
    name: card.name,
    data: structuredClone(toRaw(card.data)),
    body: card.body,
  };

  saveState.value = 'saving';
  const operation = (previous ?? Promise.resolve()).then(async () => {
    const modified = await guard(async () => writeCard(root, snapshot));
    if (modified !== undefined) card.modified = modified;
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
