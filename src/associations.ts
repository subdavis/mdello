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
  status: AssociationStatus;
  updatedAt: string;
}

export type AssociationIdentity = Pick<
  Association,
  'boardUuid' | 'cardUuid' | 'cardPath' | 'harness' | 'sessionId'
>;

/** Keys on board and card UUID when known; pre-UUID events fall back to their path. */
export function associationKey(association: AssociationIdentity): string {
  const cardIdentity =
    association.boardUuid && association.cardUuid
      ? `${association.boardUuid}\0${association.cardUuid}`
      : association.cardPath;
  return `${cardIdentity}\0${association.harness}\0${association.sessionId}`;
}
