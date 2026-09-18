import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { scanTranscript } from '@mdello/claude-extension/transcript';
import type { HarnessSessionScan } from '@mdello/common/harness';
import {
  extractMarkdownPaths,
  isModificationToolName,
  markdownToolPath,
  messageText,
  successfulModificationPaths,
} from '@mdello/common/paths';
import { DEFAULT_CONFIG_FILE, loadBoards, type ResolvedCard, resolveCard } from './boards.ts';
import {
  type Association,
  associationKey,
  DEFAULT_DATA_FILE,
  loadAssociationEvents,
  saveAssociations,
} from './server.ts';

export interface BackfillOptions {
  harness: string;
  sessionsRoot?: string;
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

/** Where one harness keeps its sessions, and how to read one. */
interface SessionScanner {
  sessionsRoot: string;
  /** Override for the root, so a test or an unusual install need not move its sessions. */
  envVar: string;
  scan?: (contents: string) => HarnessSessionScan;
  scanDatabase?: (path: string, cutoff: number) => Promise<StoredSessionScan[]>;
}

interface StoredSessionScan extends HarnessSessionScan {
  sessionFile: string;
}

const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Pi opens a session file with a `session` entry, then appends one `message` entry per turn. */
function scanPiSession(contents: string): HarnessSessionScan {
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
      // One damaged line should not hide associations elsewhere in the session.
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

interface OpenCodeRow {
  sessionId: string;
  directory: string;
  updatedAt: number;
  message: string | null;
  part: string | null;
}

async function scanOpenCodeDatabase(path: string, cutoff: number): Promise<StoredSessionScan[]> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const { DatabaseSync } = await import('node:sqlite');
  let database: InstanceType<typeof DatabaseSync>;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  try {
    const rows = database
      .prepare(
        `SELECT s.id AS sessionId, s.directory, s.time_updated AS updatedAt,
                m.data AS message, p.data AS part
           FROM session s
           LEFT JOIN message m ON m.session_id = s.id
           LEFT JOIN part p ON p.message_id = m.id
          WHERE s.time_updated >= ?
          ORDER BY s.time_updated, m.time_created, p.time_created`,
      )
      .all(cutoff) as unknown as OpenCodeRow[];
    const sessions = new Map<string, StoredSessionScan>();

    for (const row of rows) {
      let scan = sessions.get(row.sessionId);
      if (!scan) {
        scan = {
          sessionId: row.sessionId,
          sessionFile: path,
          updatedAt: new Date(row.updatedAt).toISOString(),
          cardPaths: [],
        };
        sessions.set(row.sessionId, scan);
      }

      const message = parseJson(row.message);
      const part = parseJson(row.part);
      if (!part) continue;
      if (message?.role === 'user' && part.type === 'text' && part.synthetic !== true) {
        for (const cardPath of extractMarkdownPaths(String(part.text ?? ''))) {
          if (!scan.cardPaths.includes(cardPath)) scan.cardPaths.push(cardPath);
        }
      }
      const state = record(part.state);
      if (
        part.type === 'tool' &&
        isModificationToolName(part.tool) &&
        state?.status === 'completed'
      ) {
        const cardPath = markdownToolPath(record(state.input)?.filePath, row.directory);
        if (cardPath && !scan.cardPaths.includes(cardPath)) scan.cardPaths.push(cardPath);
      }
    }
    return [...sessions.values()];
  } finally {
    database.close();
  }
}

const xdgDataHome =
  process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME
    : resolve(homedir(), '.local', 'share');

const SCANNERS: Record<string, SessionScanner> = {
  claude: {
    sessionsRoot: resolve(homedir(), '.claude', 'projects'),
    envVar: 'CLAUDE_SESSIONS_DIR',
    scan: scanTranscript,
  },
  opencode: {
    sessionsRoot: resolve(xdgDataHome, 'opencode', 'opencode.db'),
    envVar: 'OPENCODE_SESSIONS_DB',
    scanDatabase: scanOpenCodeDatabase,
  },
  pi: {
    sessionsRoot: resolve(homedir(), '.pi', 'agent', 'sessions'),
    envVar: 'PI_SESSIONS_DIR',
    scan: scanPiSession,
  },
};

export const BACKFILL_HARNESSES = Object.keys(SCANNERS);

/** Where each harness keeps its sessions, so help output need not restate the defaults. */
export const BACKFILL_SOURCES = Object.entries(SCANNERS).map(([harness, scanner]) => ({
  harness,
  envVar: scanner.envVar,
  sessionsRoot: scanner.sessionsRoot,
}));

export function isBackfillHarness(value: unknown): value is string {
  return typeof value === 'string' && value in SCANNERS;
}

async function listSessionFiles(root: string, cutoff: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // A harness that was never installed has no sessions directory, which is not a failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

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

async function scanStoredSessions(
  scanner: SessionScanner,
  sessionsRoot: string,
  cutoff: number,
): Promise<StoredSessionScan[]> {
  if (scanner.scanDatabase) return scanner.scanDatabase(sessionsRoot, cutoff);
  const scan = scanner.scan;
  if (!scan) return [];
  const sessionFiles = await listSessionFiles(sessionsRoot, cutoff);
  return Promise.all(
    sessionFiles.map(async (sessionFile) => ({
      ...scan(await readFile(sessionFile, 'utf8')),
      sessionFile,
    })),
  );
}

function recoveredAssociation(
  card: ResolvedCard,
  harness: string,
  sessionId: string,
  sessionFile: string,
  timestamp: string | undefined,
  existing: Association | undefined,
): Association {
  const recovered: Association = {
    ...card,
    harness,
    sessionId,
    sessionFile,
    status: 'closed',
    updatedAt: timestamp ?? new Date().toISOString(),
  };
  if (!existing || existing.status === 'closed') return recovered;
  return { ...recovered, status: existing.status, updatedAt: existing.updatedAt };
}

export async function backfillAssociations(options: BackfillOptions): Promise<BackfillResult> {
  const { harness } = options;
  const scanner = SCANNERS[harness];
  if (!scanner) throw new Error(`Cannot backfill unknown harness: ${harness}`);

  const sessionsRoot = resolve(
    options.sessionsRoot ?? process.env[scanner.envVar] ?? scanner.sessionsRoot,
  );
  const dataFile = resolve(
    options.dataFile ?? process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE,
  );
  const configFile = resolve(
    options.configFile ?? process.env.MDELLO_COMPANION_CONFIG ?? DEFAULT_CONFIG_FILE,
  );
  const boards = await loadBoards(configFile);
  const events = await loadAssociationEvents(dataFile);
  // Only this harness is rebuilt from its sessions; every other harness's history is passed through.
  const replaced = events.filter((association) => association.harness === harness);
  const retained = events.filter((association) => association.harness !== harness);
  const existing = new Map(
    replaced.map((association) => [associationKey(association), association]),
  );

  const cutoff = (options.now ?? new Date()).getTime() - MAX_LOOKBACK_MS;
  const sessions = await scanStoredSessions(scanner, sessionsRoot, cutoff);
  const replacement = new Map<string, Association>();
  let matchedSessions = 0;
  let foundAssociations = 0;
  let existingAssociations = 0;

  for (const scan of sessions) {
    if (!scan.sessionId || scan.cardPaths.length === 0) continue;
    let matched = false;

    for (const cardPath of scan.cardPaths) {
      const card = await resolveCard(cardPath, boards);
      if (!card) continue;
      matched = true;
      foundAssociations += 1;
      const key = associationKey({ ...card, harness, sessionId: scan.sessionId });
      const existingAssociation = existing.get(key);
      if (existingAssociation) existingAssociations += 1;
      replacement.set(
        key,
        recoveredAssociation(
          card,
          harness,
          scan.sessionId,
          scan.sessionFile,
          scan.updatedAt,
          existingAssociation,
        ),
      );
    }
    if (matched) matchedSessions += 1;
  }

  await saveAssociations(dataFile, [...retained, ...replacement.values()]);
  const purgedAssociations = [...existing.keys()].filter((key) => !replacement.has(key)).length;

  return {
    scannedSessions: sessions.length,
    matchedSessions,
    foundAssociations,
    addedAssociations: [...replacement.keys()].filter((key) => !existing.has(key)).length,
    existingAssociations,
    purgedAssociations,
  };
}
