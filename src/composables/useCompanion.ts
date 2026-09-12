import { computed, onScopeDispose, type Ref, reactive, readonly, ref, watch } from 'vue';
import type { Card } from '../fs/board';

export type AssociationStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'ready_for_review'
  | 'closed';

export interface Association {
  cardPath: string;
  harness: string;
  sessionId: string;
  sessionFile?: string;
  status: AssociationStatus;
  updatedAt: string;
}

const STATUS_PRIORITY: Record<AssociationStatus, number> = {
  closed: 0,
  idle: 1,
  ready_for_review: 2,
  running: 3,
  waiting_for_input: 4,
};

export function aggregateStatus(entries: Association[]): AssociationStatus | undefined {
  return entries.reduce<AssociationStatus | undefined>((highest, entry) => {
    if (!highest || STATUS_PRIORITY[entry.status] > STATUS_PRIORITY[highest]) return entry.status;
    return highest;
  }, undefined);
}

const endpoint = (import.meta.env.VITE_MDELLO_COMPANION_URL ?? 'http://127.0.0.1:31337').replace(
  /\/$/,
  '',
);
export type CompanionConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected';

const associations = reactive(new Map<string, Association>());
const connectionStatus = ref<CompanionConnectionStatus>('disabled');
let eventSource: EventSource | undefined;

function key(association: Pick<Association, 'cardPath' | 'harness' | 'sessionId'>): string {
  return `${association.cardPath}\0${association.harness}\0${association.sessionId}`;
}

function accept(association: Association): void {
  associations.set(key(association), association);
}

export async function acknowledgeReadyForReview(entries: Association[]): Promise<void> {
  await Promise.allSettled(
    entries
      .filter((association) => association.status === 'ready_for_review')
      .map((association) =>
        fetch(`${endpoint}/associations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...association, status: 'idle' }),
        }),
      ),
  );
}

function disconnect(): void {
  const source = eventSource;
  eventSource = undefined;
  source?.close();
  associations.clear();
  connectionStatus.value = 'disabled';
}

function connect(): void {
  if (eventSource) return;
  if (typeof EventSource === 'undefined') {
    connectionStatus.value = 'disconnected';
    return;
  }

  connectionStatus.value = 'connecting';
  const source = new EventSource(`${endpoint}/events`);
  eventSource = source;
  source.addEventListener('open', () => {
    if (eventSource === source) connectionStatus.value = 'connected';
  });
  source.addEventListener('error', () => {
    if (eventSource === source) connectionStatus.value = 'disconnected';
  });
  source.addEventListener('snapshot', (event) => {
    if (eventSource !== source) return;
    associations.clear();
    for (const association of JSON.parse(event.data) as Association[]) accept(association);
  });
  source.addEventListener('association', (event) => {
    if (eventSource === source) accept(JSON.parse(event.data) as Association);
  });
}

export function useCompanionConnectionStatus(
  enabled: Readonly<Ref<boolean>>,
): Readonly<Ref<CompanionConnectionStatus>> {
  watch(enabled, (next) => (next ? connect() : disconnect()), { immediate: true });
  onScopeDispose(disconnect);
  return readonly(connectionStatus);
}

export function useCompanion(rootPath: Ref<string>, card: Card) {
  const cardPath = computed(() => {
    const root = rootPath.value.replace(/[\\/]$/, '');
    return root ? `${root}/${card.name}` : '';
  });

  return computed(() =>
    [...associations.values()]
      .filter((association) => association.cardPath === cardPath.value)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  );
}
