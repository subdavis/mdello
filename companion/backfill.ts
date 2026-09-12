import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  DEFAULT_CONFIG_FILE,
  findBoardForPath,
  loadBoards,
  readBoardUuid,
  registerBoard,
  resolveCard,
} from './boards.ts';
import { extractCardPaths, messageText, successfulModificationPaths } from './paths.ts';
import {
  type Association,
  associationKey,
  DEFAULT_DATA_FILE,
  loadAssociationEvents,
  saveAssociations,
} from './server.ts';

export interface BackfillOptions {
  sessionsRoot?: string;
  boardRoot: string;
  dataFile?: string;
  configFile?: string;
  now?: Date;
}

export interface BackfillResult {
  scannedSessions: number;
  matchedSessions: number;
  foundAssociations: number;
  addedAssociations: number;
  existingAssociations: number;
  purgedAssociations: number;
}

interface SessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  cardPaths: Set<string>;
  messages: unknown[];
}

const DEFAULT_SESSIONS_ROOT = resolve(homedir(), '.pi', 'agent', 'sessions');
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

async function listSessionFiles(root: string, cutoff: number): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return listSessionFiles(path, cutoff);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return [];
      return (await stat(path)).mtimeMs >= cutoff ? [path] : [];
    }),
  );
  return nested.flat();
}

function noteTimestamp(scan: SessionScan, value: unknown): void {
  if (typeof value === 'string' && (!scan.timestamp || value > scan.timestamp)) {
    scan.timestamp = value;
  }
}

function noteMessage(scan: SessionScan, message: Record<string, unknown>, boardRoot: string): void {
  scan.messages.push(message);
  if (message.role !== 'user') return;
  for (const cardPath of extractCardPaths(messageText(message.content), boardRoot)) {
    scan.cardPaths.add(cardPath);
  }
}

function noteEntry(scan: SessionScan, entry: Record<string, unknown>, boardRoot: string): void {
  noteTimestamp(scan, entry.timestamp);
  if (entry.type === 'session') {
    if (typeof entry.id === 'string') scan.sessionId = entry.id;
    if (typeof entry.cwd === 'string') scan.cwd = entry.cwd;
  }
  if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
    noteMessage(scan, entry.message as Record<string, unknown>, boardRoot);
  }
}

function noteSuccessfulModifications(scan: SessionScan, boardRoot: string): void {
  for (const path of successfulModificationPaths(scan.messages, scan.cwd)) {
    for (const cardPath of extractCardPaths(path, boardRoot)) scan.cardPaths.add(cardPath);
  }
}

async function scanSession(file: string, boardRoot: string): Promise<SessionScan> {
  const scan: SessionScan = { cardPaths: new Set(), messages: [] };
  const lines = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      noteEntry(scan, JSON.parse(line) as Record<string, unknown>, boardRoot);
    } catch {
      // One damaged line should not hide associations elsewhere in the session.
    }
  }

  noteSuccessfulModifications(scan, boardRoot);
  return scan;
}

export async function backfillAssociations(options: BackfillOptions): Promise<BackfillResult> {
  const sessionsRoot = resolve(
    options.sessionsRoot ?? process.env.PI_SESSIONS_DIR ?? DEFAULT_SESSIONS_ROOT,
  );
  const boardRoot = resolve(options.boardRoot);
  const dataFile = resolve(
    options.dataFile ?? process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE,
  );
  const configFile = resolve(
    options.configFile ?? process.env.MDELLO_COMPANION_CONFIG ?? DEFAULT_CONFIG_FILE,
  );
  const boards = await loadBoards(configFile);
  const boardUuid = await readBoardUuid(boardRoot);
  const board = await registerBoard(configFile, boards, { uuid: boardUuid, path: boardRoot });
  const events = await loadAssociationEvents(dataFile);
  const belongsToBoard = (association: Association) =>
    association.boardUuid === boardUuid ||
    (!association.boardUuid && findBoardForPath(association.cardPath, [board]) !== undefined);
  const replaced = events.filter(belongsToBoard);
  const retained = events.filter((association) => !belongsToBoard(association));
  const existing = new Map(
    replaced.map((association) => [associationKey(association), association]),
  );

  const cutoff = (options.now ?? new Date()).getTime() - MAX_LOOKBACK_MS;
  const sessionFiles = await listSessionFiles(sessionsRoot, cutoff);
  const replacement = new Map<string, Association>();
  let matchedSessions = 0;
  let foundAssociations = 0;
  let existingAssociations = 0;

  for (const sessionFile of sessionFiles) {
    const scan = await scanSession(sessionFile, boardRoot);
    if (!scan.sessionId || scan.cardPaths.size === 0) continue;
    matchedSessions += 1;

    for (const cardPath of scan.cardPaths) {
      const card = await resolveCard(cardPath, boards);
      if (card?.boardUuid !== boardUuid) continue;
      foundAssociations += 1;
      const association: Association = {
        ...card,
        harness: 'pi',
        sessionId: scan.sessionId,
        sessionFile,
        status: 'closed',
        updatedAt: scan.timestamp ?? new Date().toISOString(),
      };
      const key = associationKey(association);
      const existingAssociation = existing.get(key);
      if (existingAssociation) existingAssociations += 1;
      replacement.set(
        key,
        existingAssociation && existingAssociation.status !== 'closed'
          ? {
              ...association,
              status: existingAssociation.status,
              updatedAt: existingAssociation.updatedAt,
            }
          : association,
      );
    }
  }

  await saveAssociations(dataFile, [...retained, ...replacement.values()]);
  const purgedAssociations = [...existing.keys()].filter((key) => !replacement.has(key)).length;

  return {
    scannedSessions: sessionFiles.length,
    matchedSessions,
    foundAssociations,
    addedAssociations: [...replacement.keys()].filter((key) => !existing.has(key)).length,
    existingAssociations,
    purgedAssociations,
  };
}
