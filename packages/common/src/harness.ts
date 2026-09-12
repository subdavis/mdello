import type { AssociationStatus } from './associations.ts';

/** One harness lifecycle event, expressed in companion terms. */
export interface HarnessHookEvent {
  sessionId: string;
  sessionFile?: string;
  status: AssociationStatus;
  /** Cards this event revealed. Companion also republishes the session's already-known cards. */
  cardPaths: string[];
}

/**
 * Everything backfill needs from one stored session, in companion terms. A harness owns the shape
 * of its own session files, so it reads them; the companion only resolves cards and writes records.
 */
export interface HarnessSessionScan {
  sessionId?: string;
  /** Latest activity in the session, used as the recovered association's timestamp. */
  updatedAt?: string;
  cardPaths: string[];
}

/**
 * Translates a harness webhook payload into companion terms.
 *
 * An adapter ships with its harness, not with the companion, so harness-specific lifecycle and
 * payload knowledge stays out of the sidecar. Companion only holds the registry entry.
 */
export interface HarnessAdapter {
  harness: string;
  /** Returns `undefined` when a payload carries nothing worth publishing. */
  translate(payload: unknown): Promise<HarnessHookEvent | undefined>;
}
