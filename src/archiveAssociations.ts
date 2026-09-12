import { type AssociationStatus, isAssociationStatus } from './associations.ts';
import type { Frontmatter } from './fs/frontmatter';

export const SESSION_ASSOCIATIONS_KEY = 'sessionAssociations';

export interface SessionAssociation {
  harness: string;
  sessionId: string;
  sessionFile?: string;
  status: AssociationStatus;
  updatedAt: string;
}

interface ArchiveOperations<Result> {
  persist: () => Promise<void>;
  expunge: () => Promise<void>;
  move: () => Promise<Result>;
}

function readAssociation(value: unknown): SessionAssociation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const association = value as Partial<SessionAssociation>;
  if (
    typeof association.harness !== 'string' ||
    !association.harness ||
    typeof association.sessionId !== 'string' ||
    !association.sessionId ||
    (association.sessionFile !== undefined && typeof association.sessionFile !== 'string') ||
    !isAssociationStatus(association.status) ||
    typeof association.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    harness: association.harness,
    sessionId: association.sessionId,
    ...(association.sessionFile ? { sessionFile: association.sessionFile } : {}),
    status: association.status,
    updatedAt: association.updatedAt,
  };
}

export function mergeSessionAssociations(
  existing: unknown,
  current: unknown[],
): SessionAssociation[] {
  const merged = new Map<string, SessionAssociation>();
  const candidates = [...(Array.isArray(existing) ? existing : []), ...current];
  for (const candidate of candidates) {
    const association = readAssociation(candidate);
    if (!association) continue;
    const key = `${association.harness}\0${association.sessionId}`;
    const previous = merged.get(key);
    if (!previous || association.updatedAt >= previous.updatedAt) merged.set(key, association);
  }
  return [...merged.values()].sort((left, right) =>
    left.updatedAt === right.updatedAt
      ? left.sessionId.localeCompare(right.sessionId)
      : left.updatedAt.localeCompare(right.updatedAt),
  );
}

export async function archiveWithSessionAssociations<Result>(
  data: Frontmatter,
  current: unknown[],
  operations: ArchiveOperations<Result>,
): Promise<Result> {
  const previous = data[SESSION_ASSOCIATIONS_KEY];
  const hadPrevious = Object.hasOwn(data, SESSION_ASSOCIATIONS_KEY);
  const merged = mergeSessionAssociations(previous, current);
  const changed = JSON.stringify(previous ?? []) !== JSON.stringify(merged);

  if (changed) {
    data[SESSION_ASSOCIATIONS_KEY] = merged;
    try {
      await operations.persist();
    } catch (error) {
      if (hadPrevious) data[SESSION_ASSOCIATIONS_KEY] = previous;
      else delete data[SESSION_ASSOCIATIONS_KEY];
      throw error;
    }
  }

  await operations.expunge();
  return operations.move();
}
