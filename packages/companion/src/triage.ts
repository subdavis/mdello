import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serializeFile } from '@mdello/common/frontmatter';

export const TRIAGE_COLUMN = 'Triage';
const MAX_SLUG = 60;
const MAX_COLLISIONS = 100;

export interface TriageItem {
  title: string;
  body: string;
  /** Matches any card text that already references this item. */
  bound: RegExp;
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

async function activeCardTexts(boardPath: string): Promise<string[]> {
  const entries = await readdir(boardPath, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => readFile(resolve(boardPath, entry.name), 'utf8')),
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

/** Creates a Triage card for every item no active card references. Never touches existing cards. */
export async function triageItems(
  boardPath: string,
  items: TriageItem[],
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const created: string[] = [];
  for (const item of items) {
    // Re-read per item so a card created meanwhile (by us or the app) still dedups.
    const texts = await activeCardTexts(boardPath);
    if (texts.some((text) => item.bound.test(text))) continue;
    const data = {
      uuid: crypto.randomUUID(),
      title: item.title,
      column: TRIAGE_COLUMN,
      created: now().toISOString(),
    };
    created.push(
      await writeNewCard(boardPath, slugify(item.title), serializeFile(data, item.body)),
    );
  }
  return created;
}

export function markdownTable(header: string, rows: Array<[string, string | undefined]>): string {
  const lines = rows
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(([name, value]) => `| ${name} | ${value.replace(/\|/g, '\\|')} |`);
  return [`| ${header} | Value |`, '| --- | --- |', ...lines].join('\n');
}
