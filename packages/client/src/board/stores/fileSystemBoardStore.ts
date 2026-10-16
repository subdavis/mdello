import {
  ATTACHMENTS_DIR,
  deleteAttachment,
  readAttachment,
  writeAttachment,
} from '../../fs/attachments';
import { readBackground, writeBackground } from '../../fs/background';
import {
  ARCHIVE_DIR,
  archiveCard,
  createCard,
  initBoard,
  scanBoard,
  unarchiveCard,
  writeCard,
} from '../../fs/board';
import { CONFIG_FILE, readConfig, writeConfig } from '../../fs/config';
import { changePaths, watchBoard } from '../../fs/watch';
import { takeLegacyLabels } from '../../migrations/legacyLabels';
import type { ArchiveToken, BoardSettings, Card, CardAttachment } from '../../types/board';
import { ensureBoardUuid } from '../../types/board';
import type { BoardSnapshot, BoardStore, NewCard, StorageInvalidation } from '../store';
import { splitToken, toFrontmatter } from './cardFrontmatter';

/** How long one of our own writes keeps suppressing the change event it will provoke. */
const ECHO_WINDOW = 1000;

export class FileSystemBoardStore implements BoardStore {
  readonly id: string;
  readonly name: string;

  #root: FileSystemDirectoryHandle;
  /** Relative path -> when we last wrote it, so the observer can ignore our own echoes. */
  #ourWrites = new Map<string, number>();

  constructor(id: string, root: FileSystemDirectoryHandle) {
    this.id = id;
    this.name = root.name;
    this.#root = root;
  }

  /** Called immediately before or after every write this store performs. */
  #noteWrite(...paths: string[]): void {
    const now = Date.now();
    for (const path of paths) this.#ourWrites.set(path, now);
  }

  /** True when we wrote this path recently enough that the event is almost certainly ours. */
  #isEcho(path: string): boolean {
    const now = Date.now();
    for (const [key, at] of this.#ourWrites) {
      if (now - at > ECHO_WINDOW) this.#ourWrites.delete(key);
    }

    const at = this.#ourWrites.get(path);
    return at !== undefined && now - at <= ECHO_WINDOW;
  }

  async load(): Promise<BoardSnapshot> {
    const settings = await readConfig(this.#root);

    // Two one-time adoptions, both of which belong to this backend: boards written before
    // board identity existed, and labels stranded in localStorage before they lived in config.
    const minted = ensureBoardUuid(settings);
    const legacy = settings.labels.length === 0 ? takeLegacyLabels() : [];
    if (legacy.length) settings.labels = legacy;
    if (minted || legacy.length) await this.saveSettings(settings);

    return { settings, cards: await scanBoard(this.#root) };
  }

  async saveSettings(settings: BoardSettings): Promise<void> {
    this.#noteWrite(CONFIG_FILE);
    await writeConfig(this.#root, settings);
    this.#noteWrite(CONFIG_FILE);
  }

  async scaffold(): Promise<void> {
    await initBoard(this.#root);
  }

  async createCard(input: NewCard): Promise<Card> {
    const card = await createCard(this.#root, input.column, input.title, input.order, input.body);
    this.#noteWrite(card.name);
    return card;
  }

  async saveCard(card: Readonly<Card>): Promise<{ modified: number }> {
    this.#noteWrite(card.name);
    const modified = await writeCard(this.#root, card.name, toFrontmatter(card), card.body);
    this.#noteWrite(card.name);
    return { modified };
  }

  async archiveCard(card: Readonly<Card>): Promise<ArchiveToken> {
    // Noted on both sides of the move: the removal event can land before this resolves.
    this.#noteWrite(card.name);
    const archived = await archiveCard(this.#root, card);
    const key = `${archived.dir}/${archived.name}`;
    this.#noteWrite(card.name, key);
    return { key };
  }

  async restoreCard(token: ArchiveToken): Promise<{ name: string; modified?: number }> {
    this.#noteWrite(token.key);
    const name = await unarchiveCard(this.#root, splitToken(token));
    this.#noteWrite(name, token.key);
    return { name };
  }

  async writeAttachment(file: File): Promise<CardAttachment> {
    return writeAttachment(this.#root, file);
  }

  async readAttachment(attachment: CardAttachment): Promise<File> {
    return readAttachment(this.#root, attachment);
  }

  async deleteAttachment(attachment: CardAttachment): Promise<void> {
    await deleteAttachment(this.#root, attachment);
  }

  async readBackground(): Promise<Blob | null> {
    return readBackground(this.#root);
  }

  async writeBackground(file: File): Promise<void> {
    // The wallpaper write also deletes any differently-named predecessor, so every path it
    // touched is suppressed: the controller reloads the background itself straight after.
    this.#noteWrite(...(await writeBackground(this.#root, file)));
  }

  /**
   * Translates raw file events into what went stale. Only this class knows which paths are
   * config, cards, background, or noise, and only this class knows which writes were its own.
   */
  async watch(invalidate: (change: StorageInvalidation) => void): Promise<(() => void) | null> {
    return watchBoard(this.#root, (records) => {
      for (const record of records) {
        for (const path of changePaths(record)) {
          const change = this.#classify(path);
          if (change) invalidate(change);
        }
      }
    });
  }

  #classify(path: string[]): StorageInvalidation | null {
    const [top, ...rest] = path;
    // The root itself changed: we cannot tell what, so everything is suspect.
    if (top === undefined) return 'all';
    if (this.#isEcho(path.join('/'))) return null;

    if (rest.length === 0 && top === CONFIG_FILE) return 'settings';
    if (rest.length === 0 && /^background\./i.test(top)) return 'background';
    if (rest.length === 0 && top.endsWith('.md') && !top.startsWith('.')) return 'cards';
    // An archive move reports the archived copy too; the board-root half already covered it.
    if (top === ARCHIVE_DIR || top === ATTACHMENTS_DIR || top.startsWith('.')) return null;
    return null;
  }

  async close(): Promise<void> {
    this.#ourWrites.clear();
  }
}
