import { openWritable } from './writable';

export const ATTACHMENTS_DIR = 'attachments';

export interface CardAttachment {
  /** Filename inside the board's `attachments` directory. */
  file: string;
  /** Original filename shown in the UI. */
  name: string;
  /** MIME type reported when the file was attached; may be empty. */
  type: string;
}

function safeName(name: string): string {
  const safe = [...name.normalize('NFC')]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || char === '/' || char === '\\' ? '-' : char;
    })
    .slice(0, 180)
    .join('')
    .trim();
  return safe && !/^\.+$/.test(safe) ? safe : 'attachment';
}

function attachmentFrom(value: unknown): CardAttachment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.file !== 'string' || !entry.file || typeof entry.name !== 'string') {
    return undefined;
  }

  return {
    file: entry.file,
    name: entry.name || entry.file,
    type: typeof entry.type === 'string' ? entry.type : '',
  };
}

export function readAttachments(data: Record<string, unknown>): CardAttachment[] {
  if (!Array.isArray(data.attachments)) return [];
  return data.attachments.flatMap((value) => {
    const attachment = attachmentFrom(value);
    return attachment ? [attachment] : [];
  });
}

async function attachmentsDir(
  root: FileSystemDirectoryHandle,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle(ATTACHMENTS_DIR, { create });
}

export async function writeAttachment(
  root: FileSystemDirectoryHandle,
  source: File,
): Promise<CardAttachment> {
  const dir = await attachmentsDir(root, true);
  const file = `${crypto.randomUUID()}-${safeName(source.name)}`;
  const handle = await dir.getFileHandle(file, { create: true });
  const writable = await openWritable(handle);
  await writable.write(source);
  await writable.close();

  return { file, name: source.name || 'attachment', type: source.type };
}

export async function readAttachment(
  root: FileSystemDirectoryHandle,
  attachment: CardAttachment,
): Promise<File> {
  const dir = await attachmentsDir(root);
  return (await dir.getFileHandle(attachment.file)).getFile();
}

export async function deleteAttachment(
  root: FileSystemDirectoryHandle,
  attachment: CardAttachment,
): Promise<void> {
  const dir = await attachmentsDir(root);
  await dir.removeEntry(attachment.file);
}
