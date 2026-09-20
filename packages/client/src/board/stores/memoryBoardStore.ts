import type { ArchiveToken, BoardSettings, Card, CardAttachment } from '../../types/board';
import { defaultSettings } from '../../types/board';
import type { BoardSnapshot, BoardStore, NewCard, StorageInvalidation } from '../store';

export interface MemorySeed {
  settings?: Partial<BoardSettings>;
  cards?: Array<Partial<Card> & Pick<Card, 'title' | 'column'>>;
  background?: Blob | null;
}

function slugify(title: string, fallback = 'card'): string {
  const slug = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 60);
  return slug.replace(/-$/, '') || fallback;
}

/**
 * Deliberately boring persistence: maps of plain records, cloned on the way in and out so no
 * caller can reach into storage and mutate it. Contains no board rules of any kind — no
 * validation, no ordering, no placement, no save state. Reloading the page starts it over.
 *
 * Doubles as the controller's test double, which is the point: board behaviour is tested
 * against real storage semantics without a single fake FileSystemHandle.
 */
export class MemoryBoardStore implements BoardStore {
  readonly id: string;
  readonly name: string;

  #settings: BoardSettings;
  #cards = new Map<string, Card>();
  #archived = new Map<string, Card>();
  #attachments = new Map<string, File>();
  #background: Blob | null;
  #used = new Set<string>();
  #clock = 0;

  constructor(seed: MemorySeed = {}, id = 'memory', name = 'Demo board') {
    this.id = id;
    this.name = name;
    // Cloned, so a caller keeping hold of its seed cannot reach in and mutate storage.
    this.#settings = structuredClone({
      ...defaultSettings(),
      uuid: 'memory-board',
      ...seed.settings,
    });
    this.#background = seed.background ?? null;

    for (const [index, card] of (seed.cards ?? []).entries()) {
      const uuid = card.uuid ?? `seed-${index + 1}`;
      const record: Card = {
        id: uuid,
        uuid,
        name: card.name ?? this.#allocate(`${slugify(card.title)}.md`),
        column: card.column,
        title: card.title,
        tags: card.tags ?? [],
        assignee: card.assignee,
        created: card.created ?? new Date().toISOString(),
        order: card.order ?? index + 1,
        modified: card.modified ?? this.#tick(),
        body: card.body ?? '',
        attachments: card.attachments ?? [],
        references: card.references ?? [],
        data: card.data ?? {},
      };
      this.#used.add(record.name);
      this.#cards.set(record.uuid, structuredClone(record));
    }
  }

  /**
   * Strictly increasing modification stamps. A real filesystem cannot write the same file
   * twice in one millisecond, but memory can, and equal stamps make the controller's
   * identity-preserving merge skip a card that really did change.
   */
  #tick(): number {
    this.#clock = Math.max(Date.now(), this.#clock + 1);
    return this.#clock;
  }

  /** Filenames are not load-bearing here, but staying collision-free keeps parity with disk. */
  #allocate(name: string): string {
    const match = /^(.+)(\.[^.]+)$/.exec(name);
    const base = match?.[1] ?? name;
    const ext = match?.[2] ?? '';

    for (let suffix = 0; ; suffix += 1) {
      const candidate = suffix === 0 ? `${base}${ext}` : `${base}-${suffix}${ext}`;
      if (!this.#used.has(candidate)) return candidate;
    }
  }

  async load(): Promise<BoardSnapshot> {
    return {
      settings: structuredClone(this.#settings),
      cards: [...this.#cards.values()].map((card) => structuredClone(card)),
    };
  }

  async saveSettings(settings: Readonly<BoardSettings>): Promise<void> {
    this.#settings = structuredClone(settings);
  }

  async scaffold(): Promise<void> {
    // A memory board is always seeded; there is no empty folder to fill in.
  }

  async createCard(input: NewCard): Promise<Card> {
    const uuid = crypto.randomUUID();
    const name = this.#allocate(`${slugify(input.title)}.md`);
    this.#used.add(name);

    const card: Card = {
      id: uuid,
      uuid,
      name,
      column: input.column,
      title: input.title,
      tags: [],
      created: new Date().toISOString(),
      order: input.order,
      modified: this.#tick(),
      body: input.body,
      attachments: [],
      references: [],
      data: { uuid, title: input.title, column: input.column, tags: [], order: input.order },
    };

    this.#cards.set(uuid, structuredClone(card));
    return card;
  }

  async saveCard(card: Readonly<Card>): Promise<{ modified: number }> {
    const modified = this.#tick();
    this.#cards.set(card.uuid, { ...structuredClone(card as Card), modified });
    return { modified };
  }

  async archiveCard(card: Readonly<Card>): Promise<ArchiveToken> {
    const stored = this.#cards.get(card.uuid) ?? structuredClone(card as Card);
    this.#cards.delete(card.uuid);
    this.#archived.set(card.uuid, stored);
    return { key: card.uuid };
  }

  async restoreCard(token: ArchiveToken): Promise<{ name: string; modified?: number }> {
    const card = this.#archived.get(token.key);
    if (!card) throw new Error('That card is no longer in the archive');

    this.#archived.delete(token.key);
    const modified = this.#tick();
    this.#cards.set(token.key, { ...card, modified });
    return { name: card.name, modified };
  }

  async writeAttachment(file: File): Promise<CardAttachment> {
    const key = `${crypto.randomUUID()}-${file.name || 'attachment'}`;
    this.#attachments.set(key, file);
    return { file: key, name: file.name || 'attachment', type: file.type };
  }

  async readAttachment(attachment: CardAttachment): Promise<File> {
    const file = this.#attachments.get(attachment.file);
    if (!file) throw new Error(`Attachment ${attachment.name} is missing`);
    return file;
  }

  async deleteAttachment(attachment: CardAttachment): Promise<void> {
    this.#attachments.delete(attachment.file);
  }

  async readBackground(): Promise<Blob | null> {
    return this.#background;
  }

  async writeBackground(file: File): Promise<void> {
    this.#background = file;
  }

  /** Nothing external can change memory, so there is never anything to watch. */
  async watch(_invalidate: (change: StorageInvalidation) => void): Promise<null> {
    return null;
  }

  async close(): Promise<void> {
    // Nothing to release. The seed is gone when the object is.
  }
}
