import { claudeAdapter } from '@mdello/claude-extension';
import type { Association } from '@mdello/common/associations';
import type { HarnessAdapter, HarnessHookEvent } from '@mdello/common/harness';

/** Every harness that publishes through `POST /hooks/<harness>`. Adapters own their own payloads. */
export const HARNESS_ADAPTERS: HarnessAdapter[] = [claudeAdapter];

export function findAdapter(harness: string): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS.find((adapter) => adapter.harness === harness);
}

/**
 * Status changes apply to every card a session touched, so union the event's discoveries with the
 * cards the companion already holds for it. The sidecar is the session's memory, which lets a
 * harness publish from a fresh process per event.
 */
export function sessionCardPaths(
  associations: Iterable<Association>,
  harness: string,
  sessionId: string,
): string[] {
  const paths = new Set<string>();
  for (const association of associations) {
    if (association.harness === harness && association.sessionId === sessionId) {
      paths.add(association.cardPath);
    }
  }
  return [...paths];
}

export interface HookAssociationInput {
  markdownPath: string;
  harness: string;
  sessionId: string;
  sessionFile?: string;
  status: HarnessHookEvent['status'];
}

export function hookAssociationInputs(
  event: HarnessHookEvent,
  harness: string,
  associations: Iterable<Association>,
): HookAssociationInput[] {
  const cardPaths = new Set([
    ...event.cardPaths,
    ...sessionCardPaths(associations, harness, event.sessionId),
  ]);
  return [...cardPaths].map((markdownPath) => ({
    markdownPath,
    harness,
    sessionId: event.sessionId,
    ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
    status: event.status,
  }));
}

export function harnessFromPath(pathname: string): string | undefined {
  const match = /^\/hooks\/([A-Za-z0-9_-]+)$/.exec(pathname);
  return match?.[1];
}
