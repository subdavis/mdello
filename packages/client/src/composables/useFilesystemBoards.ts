import { computed, ref, shallowRef, watch } from 'vue';
import { FileSystemBoardStore } from '../board/stores/fileSystemBoardStore';
import {
  type BoardAccess,
  type BoardRef,
  forgetBoard as dropBoard,
  grantPermission,
  listBoards,
  noteBoardPath,
  pickBoard,
  restoreBoard,
  selectBoard,
} from '../fs/handle';
import { acquireBoardLock, releaseBoardLock } from '../fs/lock';
import { promptForColumnMigration } from '../migrations/folderColumns';
import { closeBoardStore, configReady, guard, openBoardStore, rootPath } from './useBoard';

/**
 * Everything about boards that is specific to the local filesystem: the folder picker,
 * permission grants, the remembered-board registry, the cross-tab lock, and the one-off
 * folder-column migration. It hands `useBoard()` a `FileSystemBoardStore` and otherwise stays
 * out of its way.
 *
 * The dependency runs one direction only. Nothing in `useBoard.ts` imports this module, which
 * is what keeps the filesystem backend, IndexedDB, and Web Locks out of any bundle — such as
 * the marketing demo — that mounts the board UI over a different backend.
 */

const access = shallowRef<BoardAccess>({ state: 'none' });
/** Shallow: the entries hold native directory handles, which must not be proxied. */
const boards = shallowRef<BoardRef[]>([]);
/** True when another tab of this browser already has this board open. */
const locked = ref(false);

const activeId = computed(() => ('id' in access.value ? access.value.id : null));
/** The folder's own name, which the gates need before any store exists to supply one. */
const folderName = computed(() => ('handle' in access.value ? access.value.handle.name : ''));

async function refreshBoards(): Promise<void> {
  boards.value = await listBoards();
}

/**
 * The switcher lists boards by path where it can: every board folder tends to be `content`.
 * Driven off the controller's loaded settings rather than called from inside them, so the
 * controller never has to know a registry exists. Gated on `configReady` because a board being
 * closed drops `rootPath` to '' on its way out, which is not the user clearing the path.
 */
watch([rootPath, configReady], async ([path, ready]) => {
  const id = activeId.value;
  if (!ready || !id) return;
  if (await noteBoardPath(id, path)) await refreshBoards();
});

function setAccess(next: BoardAccess): void {
  access.value = next;
}

/** Takes the folder lock, then opens a store over it. A losing tab shows a gate and touches nothing. */
async function openBoard(): Promise<void> {
  locked.value = false;
  const current = access.value;

  // Nothing to open: an unsupported browser, or a profile with no boards yet.
  if (current.state !== 'ready') {
    releaseBoardLock();
    return;
  }

  if (!(await acquireBoardLock(current.id))) {
    locked.value = true;
    await closeBoardStore();
    return;
  }

  const migrated = await guard(async () => promptForColumnMigration(current.handle));
  if (migrated === undefined) return;

  await openBoardStore(new FileSystemBoardStore(current.id, current.handle));
}

async function closeBoard(): Promise<void> {
  await closeBoardStore();
  releaseBoardLock();
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

export function useFilesystemBoards() {
  return {
    access,
    boards,
    activeId,
    locked,
    folderName,

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
      await guard(async () => dropBoard(id));
      await refreshBoards();
      if (id !== activeId.value) return;

      await closeBoard();
      await guard(async () => setAccess(await restoreBoard()));
      await openBoard();
    },

    /** Re-attempt after the other tab closed. */
    retry: openBoard,
  };
}
