import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { extractCardPaths, messageText } from './paths.ts';
import { type Association, associationKey, DEFAULT_DATA_FILE, loadAssociations } from './server.ts';

export interface BackfillOptions {
  sessionsRoot?: string;
  boardRoot?: string;
  dataFile?: string;
}

export interface BackfillResult {
  scannedSessions: number;
  matchedSessions: number;
  foundAssociations: number;
  addedAssociations: number;
  existingAssociations: number;
}

interface SessionScan {
  sessionId?: string;
  timestamp?: string;
  cardPaths: Set<string>;
}

const DEFAULT_SESSIONS_ROOT = resolve(homedir(), '.pi', 'agent', 'sessions');
const DEFAULT_BOARD_ROOT = resolve(homedir(), 'Documents', 'mdello');

async function listSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listSessionFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}

function noteTimestamp(scan: SessionScan, value: unknown): void {
  if (typeof value === 'string' && (!scan.timestamp || value > scan.timestamp)) {
    scan.timestamp = value;
  }
}

async function scanSession(file: string, boardRoot: string): Promise<SessionScan> {
  const scan: SessionScan = { cardPaths: new Set() };
  const lines = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      noteTimestamp(scan, entry.timestamp);
      if (entry.type === 'session' && typeof entry.id === 'string') scan.sessionId = entry.id;
      if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;

      const message = entry.message as Record<string, unknown>;
      if (message.role !== 'user') continue;
      for (const cardPath of extractCardPaths(messageText(message.content), boardRoot)) {
        scan.cardPaths.add(cardPath);
      }
    } catch {
      // One damaged line should not hide associations elsewhere in the session.
    }
  }

  return scan;
}

export async function backfillAssociations(options: BackfillOptions = {}): Promise<BackfillResult> {
  const sessionsRoot = resolve(
    options.sessionsRoot ?? process.env.PI_SESSIONS_DIR ?? DEFAULT_SESSIONS_ROOT,
  );
  const boardRoot = resolve(
    options.boardRoot ?? process.env.MDELLO_BOARD_PATH ?? DEFAULT_BOARD_ROOT,
  );
  const dataFile = resolve(
    options.dataFile ?? process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE,
  );
  const sessionFiles = await listSessionFiles(sessionsRoot);
  const existing = await loadAssociations(dataFile);
  const additions: Association[] = [];
  let matchedSessions = 0;
  let foundAssociations = 0;
  let existingAssociations = 0;

  for (const sessionFile of sessionFiles) {
    const scan = await scanSession(sessionFile, boardRoot);
    if (!scan.sessionId || scan.cardPaths.size === 0) continue;
    matchedSessions += 1;

    for (const cardPath of scan.cardPaths) {
      foundAssociations += 1;
      const association: Association = {
        cardPath,
        harness: 'pi',
        sessionId: scan.sessionId,
        sessionFile,
        status: 'closed',
        updatedAt: scan.timestamp ?? new Date().toISOString(),
      };
      const key = associationKey(association);
      if (existing.has(key)) {
        existingAssociations += 1;
        continue;
      }
      existing.set(key, association);
      additions.push(association);
    }
  }

  if (additions.length) {
    await mkdir(dirname(dataFile), { recursive: true });
    await appendFile(
      dataFile,
      `${additions.map((association) => JSON.stringify(association)).join('\n')}\n`,
    );
  }

  return {
    scannedSessions: sessionFiles.length,
    matchedSessions,
    foundAssociations,
    addedAssociations: additions.length,
    existingAssociations,
  };
}
