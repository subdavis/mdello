import { resolve } from 'node:path';
import { type HarnessBackfill, scanJsonlSessions } from '@mdello/common/backfill';
import { codexHome } from './paths.ts';
import { scanTranscript } from './transcript.ts';

export const codexBackfill: HarnessBackfill = {
  harness: 'codex',
  envVar: 'CODEX_SESSIONS_DIR',
  get sessionsRoot() {
    return resolve(codexHome(), 'sessions');
  },
  scan: (root, cutoff) => scanJsonlSessions(root, cutoff, scanTranscript),
};
