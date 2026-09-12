let release: (() => void) | null = null;

/**
 * Takes the exclusive lock for a board, held until `releaseBoardLock()` or the tab goes away.
 * Returns false when another tab already holds it. Browsers without the Web Locks API get a
 * free pass rather than a broken app.
 *
 * Keyed by the board's registry id: Web Locks are named by string, and a directory handle
 * exposes no path or id of its own — only `isSameEntry`. See fs/handle.ts.
 */
export async function acquireBoardLock(id: string): Promise<boolean> {
  releaseBoardLock();
  if (!navigator.locks) return true;

  const name = `mdello:board:${id}`;

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
