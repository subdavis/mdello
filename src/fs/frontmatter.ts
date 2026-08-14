import { dump, load } from 'js-yaml';

export type Frontmatter = Record<string, unknown>;

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFile(text: string): { data: Frontmatter; body: string } {
  const match = FENCE.exec(text);
  if (!match) return { data: {}, body: text };

  let data: Frontmatter = {};
  try {
    const parsed = load(match[1]);
    if (parsed && typeof parsed === 'object') data = parsed as Frontmatter;
  } catch {
    // Malformed frontmatter: treat as empty rather than losing the card.
  }

  return { data, body: text.slice(match[0].length) };
}

export function serializeFile(data: Frontmatter, body: string): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return body;

  const yaml = dump(data, { lineWidth: -1, flowLevel: -1 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

export function readString(data: Frontmatter, key: string): string | undefined {
  const value = data[key];
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

export function readNumber(data: Frontmatter, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readTags(data: Frontmatter): string[] {
  return Array.isArray(data.tags) ? data.tags.map(String) : [];
}
