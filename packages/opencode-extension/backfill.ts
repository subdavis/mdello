import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { HarnessBackfill, StoredHarnessSessionScan } from '@mdello/common/backfill';
import {
  extractMarkdownPaths,
  isModificationToolName,
  markdownToolPath,
} from '@mdello/common/paths';

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

export async function scanOpenCodeDatabase(
  path: string,
  cutoff: number,
): Promise<StoredHarnessSessionScan[]> {
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
    const sessions = new Map<string, StoredHarnessSessionScan>();

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

export const opencodeBackfill: HarnessBackfill = {
  harness: 'opencode',
  envVar: 'OPENCODE_SESSIONS_DB',
  sessionsRoot: resolve(xdgDataHome, 'opencode', 'opencode.db'),
  scan: scanOpenCodeDatabase,
};
