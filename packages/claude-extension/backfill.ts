import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { type HarnessBackfill, scanJsonlSessions } from '@mdello/common/backfill';
import { scanTranscript } from './transcript.ts';

export const claudeBackfill: HarnessBackfill = {
  harness: 'claude',
  envVar: 'CLAUDE_SESSIONS_DIR',
  sessionsRoot: resolve(homedir(), '.claude', 'projects'),
  scan: (sessionsRoot, cutoff) => scanJsonlSessions(sessionsRoot, cutoff, scanTranscript),
};
