import { get, set } from 'idb-keyval';

const STORE_KEY = 'mdello:board-handle';

export type BoardAccess =
  | { state: 'unsupported' }
  | { state: 'none' }
  | { state: 'needs-permission'; handle: FileSystemDirectoryHandle }
  | { state: 'ready'; handle: FileSystemDirectoryHandle };

function isSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickBoard(): Promise<BoardAccess> {
  if (!isSupported()) return { state: 'unsupported' };

  const handle = await window.showDirectoryPicker!({
    id: 'mdello',
    mode: 'readwrite',
    startIn: 'documents',
  });
  await set(STORE_KEY, handle);
  return { state: 'ready', handle };
}

/** Restored handles usually come back as 'prompt'; re-granting needs a user gesture. */
export async function restoreBoard(): Promise<BoardAccess> {
  if (!isSupported()) return { state: 'unsupported' };

  const handle = await get<FileSystemDirectoryHandle>(STORE_KEY);
  if (!handle) return { state: 'none' };

  const permission = await handle.queryPermission?.({ mode: 'readwrite' });
  return permission === 'granted' ? { state: 'ready', handle } : { state: 'needs-permission', handle };
}

export async function grantPermission(handle: FileSystemDirectoryHandle): Promise<BoardAccess> {
  const permission = await handle.requestPermission?.({ mode: 'readwrite' });
  if (permission !== 'granted') return { state: 'needs-permission', handle };

  await set(STORE_KEY, handle);
  return { state: 'ready', handle };
}