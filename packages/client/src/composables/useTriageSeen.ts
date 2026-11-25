import { ref, watch } from 'vue';

const KEY = 'mdello:triage-seen';
export const TRIAGE_COLUMN = 'Triage';

function load(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

// Browser-local on purpose: "unseen" is a UI notification, not board data.
const seen = ref<Set<string>>(new Set(load()));

watch(seen, (value) => localStorage.setItem(KEY, JSON.stringify([...value])), { deep: true });

type TriageCard = { id: string; column: string };

export function isTriageUnseen(card: TriageCard): boolean {
  return card.column === TRIAGE_COLUMN && !seen.value.has(card.id);
}

export function acknowledgeTriage(id: string): void {
  seen.value.add(id);
}

/** Forget cards seen outside Triage, so a move back into Triage notifies again. */
// shortcut: ids of deleted/archived cards linger in storage, prune globally if the list ever grows noticeably.
export function pruneTriageSeen(cards: TriageCard[]): void {
  for (const card of cards) {
    if (card.column !== TRIAGE_COLUMN) seen.value.delete(card.id);
  }
}
