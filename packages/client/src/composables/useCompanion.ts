import {
  type Association,
  type AssociationStatus,
  associationKey,
} from '@mdello/common/associations';
import { computed, onScopeDispose, type Ref, reactive, readonly, ref, watch } from 'vue';
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

const endpoint = (import.meta.env?.VITE_MDELLO_COMPANION_URL ?? 'http://127.0.0.1:51618').replace(
  /\/$/,
  '',
);
export type CompanionConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected';

const associations = reactive(new Map<string, Association>());
const connectionStatus = ref<CompanionConnectionStatus>('disabled');
const herdrEnabled = ref(false);
const autofocus = ref(false);
const githubEnabled = ref(false);
const githubLinkEnrichment = ref(false);
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

export async function expungeCardAssociations(cardUuid: string): Promise<void> {
  const query = new URLSearchParams({ cardUuid });
  const response = await fetch(`${endpoint}/associations?${query}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Expunging companion associations failed: ${response.status}`);
  for (const [key, association] of associations) {
    if (association.cardUuid === cardUuid) associations.delete(key);
  }
}

export type ForgetSessionScope = 'card' | 'all';

export async function forgetSession(
  association: Association,
  scope: ForgetSessionScope,
): Promise<boolean> {
  const query = new URLSearchParams({
    harness: association.harness,
    sessionId: association.sessionId,
  });
  if (scope === 'card') {
    if (!association.cardUuid) return false;
    query.set('cardUuid', association.cardUuid);
  }
  try {
    const response = await fetch(`${endpoint}/associations?${query}`, { method: 'DELETE' });
    if (!response.ok) return false;
    for (const [key, entry] of associations) {
      if (
        entry.harness === association.harness &&
        entry.sessionId === association.sessionId &&
        (scope === 'all' || entry.cardUuid === association.cardUuid)
      ) {
        associations.delete(key);
      }
    }
    return true;
  } catch {
    return false;
  }
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

async function refreshCompanionSettings(): Promise<void> {
  try {
    const response = await fetch(`${endpoint}/settings`);
    const settings = response.ok
      ? ((await response.json()) as {
          autofocus?: boolean;
          githubEnabled?: boolean;
          githubLinkEnrichment?: boolean;
          herdrEnabled?: boolean;
        })
      : {};
    autofocus.value = settings.autofocus === true;
    githubEnabled.value = settings.githubEnabled === true;
    githubLinkEnrichment.value = settings.githubLinkEnrichment === true;
    herdrEnabled.value = settings.herdrEnabled === true;
  } catch {
    autofocus.value = false;
    githubEnabled.value = false;
    githubLinkEnrichment.value = false;
    herdrEnabled.value = false;
  }
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
  autofocus.value = false;
  githubEnabled.value = false;
  githubLinkEnrichment.value = false;
  herdrEnabled.value = false;
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
    if (eventSource !== source) return;
    connectionStatus.value = 'connected';
    void refreshCompanionSettings();
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

export function useHerdrEnabled(): Readonly<Ref<boolean>> {
  return readonly(herdrEnabled);
}

export function useCompanionStatus(): Readonly<Ref<CompanionConnectionStatus>> {
  return readonly(connectionStatus);
}

export function useAutofocus(): Readonly<Ref<boolean>> {
  return readonly(autofocus);
}

export function useGitHubEnabled(): Readonly<Ref<boolean>> {
  return readonly(githubEnabled);
}

export function useGitHubLinkEnrichment(): Readonly<Ref<boolean>> {
  return readonly(githubLinkEnrichment);
}

export async function setAutofocus(enabled: boolean): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autofocus: enabled }),
    });
    if (!response.ok) return false;
    autofocus.value = enabled;
    return true;
  } catch {
    return false;
  }
}

export async function setGitHubLinkEnrichment(enabled: boolean): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ githubLinkEnrichment: enabled }),
    });
    if (!response.ok) return false;
    githubLinkEnrichment.value = enabled;
    return true;
  } catch {
    return false;
  }
}

export interface UrlEnrichment {
  provider: string;
  url: string;
}

export function subscribeUrlEnrichments(
  urls: string[],
  onDetails: (details: UrlEnrichment[]) => void,
): () => void {
  if (urls.length === 0 || typeof EventSource === 'undefined') return () => undefined;
  const query = new URLSearchParams();
  for (const url of urls) query.append('url', url);
  const details = new Map<string, UrlEnrichment>();
  let source: EventSource;
  try {
    source = new EventSource(`${endpoint}/enrichments?${query}`);
  } catch {
    return () => undefined;
  }
  source.addEventListener('enrichments', (event) => {
    try {
      const result = JSON.parse(event.data) as { items?: UrlEnrichment[] };
      if (!Array.isArray(result.items)) return;
      for (const item of result.items) details.set(item.url, item);
      onDetails([...details.values()]);
    } catch {
      // Ignore malformed events; EventSource keeps the subscription alive.
    }
  });
  return () => source.close();
}

export async function focusSession(association: Association): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'focus',
        harness: association.harness,
        sessionId: association.sessionId,
        sessionFile: association.sessionFile,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function resumeCommand(association: Association): string | undefined {
  if (association.harness === 'pi' || association.harness === 'unknown') {
    return `pi --session ${association.sessionId}`;
  }
  if (association.harness === 'claude') {
    return `claude --resume ${association.sessionId}`;
  }
  if (association.harness === 'opencode') {
    return `opencode --session ${association.sessionId}`;
  }
  return undefined;
}

function cardFilePath(rootPath: string, card: Card): string {
  const root = rootPath.replace(/[\\/]$/, '');
  return root ? `${root}/${card.name}` : '';
}

export function useCompanion(rootPath: Ref<string>, card: Card) {
  const cardPath = computed(() => {
    return cardFilePath(rootPath.value, card);
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
