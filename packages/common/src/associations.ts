/**
 * Companion association identity, shared by the browser app and the Node companion.
 * Both sides must derive the same key or the app silently duplicates live sessions.
 */

export const ASSOCIATION_STATUSES = [
  'idle',
  'running',
  'waiting_for_input',
  'ready_for_review',
  'closed',
] as const;

export type AssociationStatus = (typeof ASSOCIATION_STATUSES)[number];

export function isAssociationStatus(value: unknown): value is AssociationStatus {
  return ASSOCIATION_STATUSES.includes(value as AssociationStatus);
}

export interface Association {
  boardUuid?: string;
  cardUuid?: string;
  cardPath: string;
  harness: string;
  sessionId: string;
  sessionFile?: string;
  herdrWorkspace?: string;
  herdrTab?: string;
  status: AssociationStatus;
  updatedAt: string;
}

export type AssociationIdentity = Pick<
  Association,
  'cardUuid' | 'cardPath' | 'harness' | 'sessionId'
>;

/** Card UUIDs are global; pre-UUID events fall back to their path. */
export function associationKey(association: AssociationIdentity): string {
  return `${association.cardUuid || association.cardPath}\0${association.harness}\0${association.sessionId}`;
}
