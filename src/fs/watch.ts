/** A move changes both its old and new parent directories. */
export function changePaths(record: FileSystemChangeRecord): string[][] {
  return record.type === 'moved' && record.relativePathMovedFrom
    ? [record.relativePathComponents, record.relativePathMovedFrom]
    : [record.relativePathComponents];
}

/** Watches the board tree; returns a disconnect fn, or null when unavailable. */
export async function watchBoard(
  root: FileSystemDirectoryHandle,
  onChange: (records: FileSystemChangeRecord[]) => void,
): Promise<(() => void) | null> {
  const Observer = globalThis.FileSystemObserver;
  if (!Observer) return null;

  const observer = new Observer((records) => onChange(records));
  try {
    await observer.observe(root, { recursive: true });
  } catch {
    observer.disconnect();
    return null;
  }
  return () => observer.disconnect();
}
