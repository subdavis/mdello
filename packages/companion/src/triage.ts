import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseFile, serializeFile } from '@mdello/common/frontmatter';

export const TRIAGE_COLUMN = 'Triage';
const MAX_SLUG = 60;
const MAX_COLLISIONS = 100;

export interface TriageItem {
  title: string;
  body: string;
  /** Matches any card text that already references this item. */
  bound: RegExp;
}

export interface TriageOutcome {
  item: TriageItem;
  cards: Array<{ path: string; action: 'created' | 'moved' | 'already in Triage' | 'linked' }>;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, '');
  return slug || 'card';
}

async function activeCards(boardPath: string): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(boardPath, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map(async (entry) => {
        const path = resolve(boardPath, entry.name);
        return { path, text: await readFile(path, 'utf8') };
      }),
  );
}

async function writeNewCard(boardPath: string, slug: string, text: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_COLLISIONS; attempt++) {
    const path = resolve(boardPath, `${attempt ? `${slug}-${attempt}` : slug}.md`);
    try {
      await writeFile(path, text, { flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`No free filename for ${slug}`);
}

/** Creates unbound Triage cards; optionally moves cards already referencing an item. */
export async function triageItems(
  boardPath: string,
  items: TriageItem[],
  now: () => Date = () => new Date(),
  moveExisting = false,
  report?: (outcome: TriageOutcome) => void,
): Promise<string[]> {
  const created: string[] = [];
  for (const item of items) {
    // Re-read per item so a card created meanwhile (by us or the app) still dedups.
    const cards = await activeCards(boardPath);
    const matches = cards.filter(({ text }) => item.bound.test(text));
    if (matches.length) {
      const outcomes: TriageOutcome['cards'] = [];
      for (const { path, text } of matches) {
        const { data, body } = parseFile(text);
        const action = moveExisting
          ? data.column === TRIAGE_COLUMN
            ? 'already in Triage'
            : 'moved'
          : 'linked';
        if (action === 'moved') {
          data.column = TRIAGE_COLUMN;
          await writeFile(path, serializeFile(data, body));
        }
        outcomes.push({ path, action });
      }
      report?.({ item, cards: outcomes });
      continue;
    }
    const data = {
      uuid: crypto.randomUUID(),
      title: item.title,
      column: TRIAGE_COLUMN,
      created: now().toISOString(),
    };
    const path = await writeNewCard(boardPath, slugify(item.title), serializeFile(data, item.body));
    created.push(path);
    report?.({ item, cards: [{ path, action: 'created' }] });
  }
  return created;
}

export function markdownTable(header: string, rows: Array<[string, string | undefined]>): string {
  const lines = rows
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(([name, value]) => `| ${name} | ${value.replace(/\|/g, '\\|')} |`);
  return [`| ${header} | Value |`, '| --- | --- |', ...lines].join('\n');
}
