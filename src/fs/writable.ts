/** Chrome drops a write lock asynchronously after close(), so back-to-back writes need one retry. */
export async function openWritable(
  handle: FileSystemFileHandle,
): Promise<FileSystemWritableFileStream> {
  try {
    return await handle.createWritable();
  } catch (error) {
    if ((error as DOMException).name !== 'NoModificationAllowedError') throw error;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return handle.createWritable();
  }
}
