import type { Frontmatter } from '@mdello/common/frontmatter';
import type { Reference } from '../references';

export interface CardAttachment {
  /** Storage key for the attachment contents. */
  file: string;
  /** Original filename shown in the UI. */
  name: string;
  /** MIME type reported when the file was attached; may be empty. */
  type: string;
}

export interface Card {
  /** Stable identity persisted with the card. */
  id: string;
  uuid: string;
  name: string;
  column: string;
  title: string;
  tags: string[];
  assignee?: string;
  created?: string;
  order?: number;
  modified: number;
  body: string;
  attachments: CardAttachment[];
  /** Parsed from the body on load and on save, never per keystroke. */
  references: Reference[];
  /** Raw metadata retained so storage can preserve unknown fields. */
  data: Frontmatter;
}

export interface Column {
  name: string;
  cards: Card[];
  /** Discovered from card metadata but absent from board settings. */
  virtual: boolean;
}

export interface Label {
  name: string;
  color: string;
}

export interface BoardSettings {
  /** Stable board identity, independent from its current storage location. */
  uuid: string;
  /** Ordered column names. Cards select one with their `column` metadata field. */
  columns: string[];
  /** User-supplied display path for integrations such as open-in-editor. */
  path: string;
  /** URL template used to open a card in an external editor. */
  editor: string;
  /** Whether the board should connect to the local companion sidecar. */
  companion: boolean;
  labels: Label[];
}

/** Opaque receipt returned when storage archives a card and consumed to restore it. */
export interface ArchiveToken {
  readonly key: string;
}

/**
 * Drag sentinel for the archive dropzone, which occupies a column slot without being one.
 * Deliberately independent of any storage layout: a backend may archive wherever it likes.
 */
export const ARCHIVE_TARGET = 'archive';

/** The editor template a board falls back to. The only default anything outside here needs. */
export const DEFAULT_EDITOR = 'vscode://file{path}';

/** Fresh settings for a board that has none yet. A factory, because the arrays are mutable. */
export function defaultSettings(): BoardSettings {
  return {
    uuid: '',
    columns: [],
    path: '',
    editor: DEFAULT_EDITOR,
    companion: false,
    labels: [],
  };
}

/** Settings for a brand new board, which is the only time an identity is minted. */
export function createBoardSettings(overrides: Partial<BoardSettings> = {}): BoardSettings {
  return { ...defaultSettings(), uuid: crypto.randomUUID(), ...overrides };
}

/** Mirrors ensureCardUuid: boards predating board identity are adopted on first read. */
export function ensureBoardUuid(settings: BoardSettings): boolean {
  if (settings.uuid) return false;
  settings.uuid = crypto.randomUUID();
  return true;
}
