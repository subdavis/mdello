import { get, set } from 'idb-keyval';

/**
 * Web Locks are keyed by string, but a directory handle exposes no path or id — only
 * `isSameEntry`. So handles get a persistent uuid here, shared by every tab of this
 * origin, which is exactly the scope the lock covers.
 */
const REGISTRY_KEY = 'mdello:dir-ids';

interface DirEntry {
  id: string;
  handle: FileSystemDirectoryHandle;
}

async function dirId(handle: FileSystemDirectoryHandle): Promise<string> {
  const registry = (await get<DirEntry[]>(REGISTRY_KEY)) ?? [];

  for (const entry of registry) {
    if (await entry.handle.isSameEntry(handle)) return entry.id;
  }

  const id = crypto.randomUUID();
  await set(REGISTRY_KEY, [...registry, { id, handle }]);
  return id;
}

let release: (() => void) | null = null;

/**
 * Takes the exclusive lock for a board folder, held until `releaseBoardLock()` or the
 * tab goes away. Returns false when another tab already holds it. Browsers without
 * the Web Locks API get a free pass rather than a broken app.
 */
export async function acquireBoardLock(handle: FileSystemDirectoryHandle): Promise<boolean> {
  releaseBoardLock();
  if (!navigator.locks) return true;

  const name = `mdello:board:${await dirId(handle)}`;

  return new Promise<boolean>((resolve) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        // Never settling is how a lock is held for the lifetime of the tab.
        return new Promise<void>((done) => {
          release = done;
        });
      })
      .catch(() => resolve(true));
  });
}

export function releaseBoardLock(): void {
  release?.();
  release = null;
}
