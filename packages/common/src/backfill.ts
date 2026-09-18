import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Everything companion needs from one extension-owned stored session. */
export interface HarnessSessionScan {
  sessionId?: string;
  /** Latest activity in session, used as recovered association timestamp. */
  updatedAt?: string;
  cardPaths: string[];
}

export interface StoredHarnessSessionScan extends HarnessSessionScan {
  sessionFile: string;
}

/** Extension-owned reader for one harness's persisted sessions. */
export interface HarnessBackfill {
  harness: string;
  envVar: string;
  sessionsRoot: string;
  scan(sessionsRoot: string, cutoff: number): Promise<StoredHarnessSessionScan[]>;
}

async function listJsonlFiles(root: string, cutoff: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return listJsonlFiles(path, cutoff);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return [];
      return (await stat(path)).mtimeMs >= cutoff ? [path] : [];
    }),
  );
  return nested.flat();
}

/** Shared storage traversal for harnesses that persist one JSONL file per session. */
export async function scanJsonlSessions(
  root: string,
  cutoff: number,
  scan: (contents: string) => HarnessSessionScan,
): Promise<StoredHarnessSessionScan[]> {
  const sessionFiles = await listJsonlFiles(root, cutoff);
  return Promise.all(
    sessionFiles.map(async (sessionFile) => ({
      ...scan(await readFile(sessionFile, 'utf8')),
      sessionFile,
    })),
  );
}
