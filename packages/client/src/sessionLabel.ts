import type { Association } from '@mdello/common/associations';

export function sessionLabel(association: Association): string {
  const identity =
    association.herdrWorkspace && association.herdrTab
      ? `${association.herdrWorkspace} - ${association.herdrTab}`
      : association.sessionId;
  return `${association.harness} - ${identity}`;
}
