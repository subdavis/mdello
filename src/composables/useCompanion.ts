import { computed, onScopeDispose, type Ref, reactive, readonly, ref, watch } from 'vue';
import { type Association, type AssociationStatus, associationKey } from '../associations.ts';
import type { Card } from '../fs/board';

export type { Association, AssociationStatus };

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

const endpoint = (import.meta.env?.VITE_MDELLO_COMPANION_URL ?? 'http://127.0.0.1:31337').replace(
  /\/$/,
  '',
);
export type CompanionConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected';

const associations = reactive(new Map<string, Association>());
const connectionStatus = ref<CompanionConnectionStatus>('disabled');
const RECONNECT_DELAY_MS = 1_000;

let eventSource: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function accept(association: Association): void {
  associations.set(associationKey(association), association);
}

export async function fetchCardAssociations(
  boardUuid: string,
  cardUuid: string,
): Promise<Association[]> {
  const query = new URLSearchParams({ boardUuid, cardUuid });
  const response = await fetch(`${endpoint}/associations?${query}`);
  if (!response.ok) throw new Error(`Loading companion associations failed: ${response.status}`);
  return (await response.json()) as Association[];
}

export async function expungeCardAssociations(boardUuid: string, cardUuid: string): Promise<void> {
  const query = new URLSearchParams({ boardUuid, cardUuid });
  const response = await fetch(`${endpoint}/associations?${query}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Expunging companion associations failed: ${response.status}`);
  for (const [key, association] of associations) {
    if (association.boardUuid === boardUuid && association.cardUuid === cardUuid) {
      associations.delete(key);
    }
  }
}

export async function backfillBoard(boardUuid: string, boardPath: string): Promise<void> {
  const response = await fetch(`${endpoint}/backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardUuid, boardPath }),
  });
  if (!response.ok) throw new Error(`Companion backfill failed: ${response.status}`);
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

function clearReconnectTimer(): void {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function disconnect(): void {
  clearReconnectTimer();
  const source = eventSource;
  eventSource = undefined;
  source?.close();
  associations.clear();
  connectionStatus.value = 'disabled';
}

function scheduleReconnect(boardUuid: string, boardPath: string): void {
  clearReconnectTimer();
  connectionStatus.value = 'disconnected';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect(boardUuid, boardPath);
  }, RECONNECT_DELAY_MS);
}

function connect(boardUuid: string, boardPath: string): void {
  if (eventSource || !boardUuid || !boardPath) return;
  if (typeof EventSource === 'undefined') {
    connectionStatus.value = 'disconnected';
    return;
  }

  connectionStatus.value = 'connecting';
  const query = new URLSearchParams({ boardUuid, boardPath });
  let source: EventSource;
  try {
    source = new EventSource(`${endpoint}/events?${query}`);
  } catch {
    scheduleReconnect(boardUuid, boardPath);
    return;
  }
  eventSource = source;
  source.addEventListener('open', () => {
    if (eventSource === source) connectionStatus.value = 'connected';
  });
  source.addEventListener('error', () => {
    if (eventSource !== source) return;
    eventSource = undefined;
    source.close();
    scheduleReconnect(boardUuid, boardPath);
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
  boardUuid: Readonly<Ref<string>>,
  boardPath: Readonly<Ref<string>>,
): Readonly<Ref<CompanionConnectionStatus>> {
  watch(
    [enabled, boardUuid, boardPath],
    ([nextEnabled, nextUuid, nextPath]) => {
      disconnect();
      if (nextEnabled) connect(nextUuid, nextPath);
    },
    { immediate: true },
  );
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
      .filter(
        (association) =>
          association.cardUuid === card.uuid || association.cardPath === cardPath.value,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  );
}
