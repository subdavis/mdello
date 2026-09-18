import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  type HarnessBackfill,
  type HarnessSessionScan,
  scanJsonlSessions,
} from '@mdello/common/backfill';
import {
  extractMarkdownPaths,
  messageText,
  successfulModificationPaths,
} from '@mdello/common/paths';

/** Pi opens a session file with a `session` entry, then appends one `message` entry per turn. */
export function scanPiSession(contents: string): HarnessSessionScan {
  const cardPaths = new Set<string>();
  const messages: unknown[] = [];
  const scan: HarnessSessionScan = { cardPaths: [] };
  let cwd: string | undefined;

  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const timestamp = entry.timestamp;
    if (typeof timestamp === 'string' && (!scan.updatedAt || timestamp > scan.updatedAt)) {
      scan.updatedAt = timestamp;
    }
    if (entry.type === 'session') {
      if (typeof entry.id === 'string') scan.sessionId = entry.id;
      if (typeof entry.cwd === 'string') cwd = entry.cwd;
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;

    const message = entry.message as Record<string, unknown>;
    messages.push(message);
    if (message.role !== 'user') continue;
    for (const cardPath of extractMarkdownPaths(messageText(message.content))) {
      cardPaths.add(cardPath);
    }
  }

  for (const path of successfulModificationPaths(messages, cwd)) cardPaths.add(path);
  return { ...scan, cardPaths: [...cardPaths] };
}

export const piBackfill: HarnessBackfill = {
  harness: 'pi',
  envVar: 'PI_SESSIONS_DIR',
  sessionsRoot: resolve(homedir(), '.pi', 'agent', 'sessions'),
  scan: (sessionsRoot, cutoff) => scanJsonlSessions(sessionsRoot, cutoff, scanPiSession),
};
