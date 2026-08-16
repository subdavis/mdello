import { openWritable } from './writable';

/** Wallpaper lives in the board root as `background.<ext>`; the browser decides what it can render. */
const BACKGROUND = /^background\./i;

/**
 * Returns a blob URL for the board wallpaper, or null when there is no such file.
 * Callers own the URL and must revoke it once a newer one replaces it.
 */
export async function readBackground(root: FileSystemDirectoryHandle): Promise<string | null> {
  for await (const entry of root.values()) {
    if (entry.kind !== 'file' || !BACKGROUND.test(entry.name)) continue;

    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      return URL.createObjectURL(file);
    } catch {
      return null; // Vanished between listing and reading.
    }
  }

  return null;
}

/** Extension from the dropped filename, falling back to the MIME subtype. */
function extensionOf(file: File): string {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1];
  return (fromName ?? file.type.split('/')[1] ?? 'png').toLowerCase();
}

/** Writes the board wallpaper, replacing any previous `background.*`. */
export async function writeBackground(
  root: FileSystemDirectoryHandle,
  file: File,
): Promise<void> {
  const name = `background.${extensionOf(file)}`;

  const stale: string[] = [];
  for await (const entry of root.values()) {
    if (entry.kind === 'file' && BACKGROUND.test(entry.name) && entry.name !== name) {
      stale.push(entry.name);
    }
  }

  const handle = await root.getFileHandle(name, { create: true });
  const writable = await openWritable(handle);
  await writable.write(file);
  await writable.close();

  // Removed after the write so a failed write leaves the old wallpaper in place.
  for (const entry of stale) await root.removeEntry(entry);
}
