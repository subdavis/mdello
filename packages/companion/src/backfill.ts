import { resolve } from 'node:path';
import { claudeBackfill } from '@mdello/claude-extension/backfill';
import type { HarnessBackfill } from '@mdello/common/backfill';
import { opencodeBackfill } from '@mdello/opencode-extension/backfill';
import { piBackfill } from '@mdello/pi-extension/backfill';
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

const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const BACKFILLS: HarnessBackfill[] = [claudeBackfill, opencodeBackfill, piBackfill];

export const BACKFILL_HARNESSES = BACKFILLS.map(({ harness }) => harness);

/** Where each harness keeps its sessions, so help output need not restate the defaults. */
export const BACKFILL_SOURCES = BACKFILLS.map(({ harness, envVar, sessionsRoot }) => ({
  harness,
  envVar,
  sessionsRoot,
}));

export function isBackfillHarness(value: unknown): value is string {
  return typeof value === 'string' && BACKFILLS.some(({ harness }) => harness === value);
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
  const backfill = BACKFILLS.find((candidate) => candidate.harness === harness);
  if (!backfill) throw new Error(`Cannot backfill unknown harness: ${harness}`);

  const sessionsRoot = resolve(
    options.sessionsRoot ?? process.env[backfill.envVar] ?? backfill.sessionsRoot,
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
  const sessions = await backfill.scan(sessionsRoot, cutoff);
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
