import { get, set } from 'idb-keyval';

/** Every board the user has opened. Handles live here, so a swap never re-prompts the picker. */
const BOARDS_KEY = 'mdello:boards';
/** Which of them to restore on load. */
const ACTIVE_KEY = 'mdello:board-active';
/**
 * Pre-multi-board storage: the single board handle, and lock.ts's old handle -> id map.
 * Read once during migration and then left in place, so rolling the app back still finds a board.
 */
const LEGACY_HANDLE_KEY = 'mdello:board-handle';
const LEGACY_IDS_KEY = 'mdello:dir-ids';

const REGISTRY_LOCK = 'mdello:dir-registry';

export interface BoardRef {
  /** Stable across tabs and sessions; also the name the board lock is taken under. */
  id: string;
  handle: FileSystemDirectoryHandle;
  /** `handle.name`, cached so the switcher can render a list without touching disk. */
  name: string;
  /** `path` from the board's mdello.yml, once a load has seen one. Most boards are named `content`. */
  path?: string;
  lastOpened: number;
}

export type BoardAccess =
  | { state: 'unsupported' }
  | { state: 'none' }
  | { state: 'needs-permission'; id: string; handle: FileSystemDirectoryHandle }
  | { state: 'ready'; id: string; handle: FileSystemDirectoryHandle };

function isSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

/** Lifts the one board of a pre-multi-board install into the registry, keeping its lock id. */
async function migrate(): Promise<BoardRef[]> {
  const handle = await get<FileSystemDirectoryHandle>(LEGACY_HANDLE_KEY);
  if (!handle) return [];

  // Reusing the id lock.ts already minted for this folder keeps the board lock stable across
  // the upgrade, so an old tab and a new one still contend for the same name.
  const legacy =
    (await get<{ id: string; handle: FileSystemDirectoryHandle }[]>(LEGACY_IDS_KEY)) ?? [];
  let id: string | undefined;
  for (const entry of legacy) {
    if (await entry.handle.isSameEntry(handle)) {
      id = entry.id;
      break;
    }
  }

  return [{ id: id ?? crypto.randomUUID(), handle, name: handle.name, lastOpened: Date.now() }];
}

/** An unset key means "never migrated"; an empty array means "no boards", and stays that way. */
async function readRegistry(): Promise<BoardRef[]> {
  const stored = await get<BoardRef[]>(BOARDS_KEY);
  if (stored) return stored;

  const migrated = await migrate();
  await set(BOARDS_KEY, migrated);
  return migrated;
}

/**
 * Read-modify-write on the registry, serialized against other tabs: unguarded, two tabs
 * picking folders at the same moment each write a list missing the other's board.
 */
async function editRegistry<T>(mutate: (boards: BoardRef[]) => T | Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const boards = await readRegistry();
    const result = await mutate(boards);
    await set(BOARDS_KEY, boards);
    return result;
  };

  return navigator.locks ? navigator.locks.request(REGISTRY_LOCK, run) : run();
}

function accessFor(board: BoardRef, permission: PermissionState | undefined): BoardAccess {
  return permission === 'granted'
    ? { state: 'ready', id: board.id, handle: board.handle }
    : { state: 'needs-permission', id: board.id, handle: board.handle };
}

/** Restored handles usually come back as 'prompt'; re-granting needs a user gesture. */
async function openRef(board: BoardRef): Promise<BoardAccess> {
  return accessFor(board, await board.handle.queryPermission?.({ mode: 'readwrite' }));
}

/** Most recently opened first, which is the order the switcher wants. */
export async function listBoards(): Promise<BoardRef[]> {
  const boards = await readRegistry();
  return [...boards].sort((a, b) => b.lastOpened - a.lastOpened);
}

export async function pickBoard(): Promise<BoardAccess> {
  const pickDirectory = window.showDirectoryPicker;
  if (!pickDirectory) return { state: 'unsupported' };

  const handle = await pickDirectory({
    id: 'mdello',
    mode: 'readwrite',
    startIn: 'documents',
  });

  const id = await editRegistry(async (boards) => {
    for (const board of boards) {
      if (!(await board.handle.isSameEntry(handle))) continue;
      // Re-picking a known board refreshes its handle rather than listing the folder twice.
      board.handle = handle;
      board.name = handle.name;
      board.lastOpened = Date.now();
      return board.id;
    }

    const board: BoardRef = {
      id: crypto.randomUUID(),
      handle,
      name: handle.name,
      lastOpened: Date.now(),
    };
    boards.push(board);
    return board.id;
  });

  await set(ACTIVE_KEY, id);
  // The picker itself grants readwrite, so this handle is live without a further prompt.
  return { state: 'ready', id, handle };
}

/** The board to open on load: the last active one, or whatever is left if it went away. */
export async function restoreBoard(): Promise<BoardAccess> {
  if (!isSupported()) return { state: 'unsupported' };

  const boards = await listBoards();
  const activeId = await get<string>(ACTIVE_KEY);
  const board = boards.find((entry) => entry.id === activeId) ?? boards[0];

  return board ? openRef(board) : { state: 'none' };
}

export async function selectBoard(id: string): Promise<BoardAccess> {
  const board = await editRegistry((boards) => {
    const found = boards.find((entry) => entry.id === id);
    if (found) found.lastOpened = Date.now();
    return found;
  });
  if (!board) return { state: 'none' };

  await set(ACTIVE_KEY, id);
  return openRef(board);
}

export async function grantPermission(
  id: string,
  handle: FileSystemDirectoryHandle,
): Promise<BoardAccess> {
  const permission = await handle.requestPermission?.({ mode: 'readwrite' });
  return accessFor({ id, handle, name: handle.name, lastOpened: 0 }, permission);
}

/** Drops a board from the list. The folder and its files are untouched. */
export async function forgetBoard(id: string): Promise<void> {
  await editRegistry((boards) => {
    const index = boards.findIndex((entry) => entry.id === id);
    if (index !== -1) boards.splice(index, 1);
  });
}

/** Caches the board's configured path for the switcher. Returns true when it changed. */
export async function noteBoardPath(id: string, path: string): Promise<boolean> {
  return editRegistry((boards) => {
    const board = boards.find((entry) => entry.id === id);
    const next = path || undefined;
    if (!board || board.path === next) return false;

    board.path = next;
    return true;
  });
}
