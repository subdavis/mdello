import type { ArchiveToken, BoardSettings, Card, CardAttachment } from '../types/board';

/** Everything a backend hands back on open. Grouping and ordering are the controller's job. */
export interface BoardSnapshot {
  settings: BoardSettings;
  /** Flat list. Column membership is read from each card, not from the backend's layout. */
  cards: Card[];
}

/** The fields a caller supplies; the backend allocates identity, filename, and timestamps. */
export interface NewCard {
  title: string;
  column: string;
  order: number;
  body: string;
}

/** What went stale, not what happened to it. Backends translate their own raw events. */
export type StorageInvalidation = 'settings' | 'cards' | 'background' | 'all';

/**
 * Persistence only. A store never validates a column name, decides a card's position,
 * debounces a write, or owns error state — those are board rules and live in the controller.
 */
export interface BoardStore {
  readonly id: string;
  /** Display label for the open board. The single source; do not also read a handle's name. */
  readonly name: string;

  load(): Promise<BoardSnapshot>;
  /** Takes a detached snapshot, like `saveCard`: storage never sees later edits mid-write. */
  saveSettings(settings: Readonly<BoardSettings>): Promise<void>;
  /** Writes starter content into an empty board. */
  scaffold(): Promise<void>;

  createCard(input: NewCard): Promise<Card>;
  saveCard(card: Readonly<Card>): Promise<{ modified: number }>;

  archiveCard(card: Readonly<Card>): Promise<ArchiveToken>;
  restoreCard(token: ArchiveToken): Promise<{ name: string; modified?: number }>;

  writeAttachment(file: File): Promise<CardAttachment>;
  readAttachment(attachment: CardAttachment): Promise<File>;
  deleteAttachment(attachment: CardAttachment): Promise<void>;

  /** A Blob, never an object URL: the controller owns URL creation and revocation. */
  readBackground(): Promise<Blob | null>;
  writeBackground(file: File): Promise<void>;

  /** Resolves to a disposer, or null when this backend cannot watch for external changes. */
  watch(invalidate: (change: StorageInvalidation) => void): Promise<(() => void) | null>;

  close(): Promise<void>;
}
