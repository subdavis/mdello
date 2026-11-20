/** Pure search logic shared by the Worker and tests. Knows nothing about Vue or the DOM. */

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface SearchRange {
  start: number;
  end: number;
}

/** Plain, structured-cloneable card projection sent to the Worker. */
export interface SearchDoc {
  id: string;
  title: string;
  /** Frontmatter fields other than title, already stringified. */
  fields: [key: string, value: string][];
  body: string;
}

export interface SearchMatch {
  /** Frontmatter key; absent for title and body matches. */
  field?: string;
  snippet: string;
  ranges: SearchRange[];
}

export interface SearchResult {
  id: string;
  title: string;
  titleRanges: SearchRange[];
  matches: SearchMatch[];
  count: number;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  error?: string;
}

interface Line {
  field?: string;
  text: string;
  lower: string;
}

interface Entry {
  id: string;
  title: Line;
  lines: Line[];
}

interface Finder {
  ranges(target: Line): SearchRange[];
  count(target: Line): number;
}

// Bounds payload for long lines; the sidebar trims further to its pixel width (fit.ts).
const SNIPPET_BEFORE = 120;
const SNIPPET_LENGTH = 400;
// shortcut: caps payload for huge cards, raise if users need every hit listed.
const MAX_MATCHES_PER_CARD = 200;
const collator = new Intl.Collator();

function line(text: string, field?: string): Line {
  return { field, text, lower: text.toLowerCase() };
}

export function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(stringifyValue).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

/** Lowercased lines are precomputed so plain-text queries never re-lowercase the board. */
export class SearchIndex {
  private entries = new Map<string, Entry>();

  upsert(docs: SearchDoc[]): void {
    for (const doc of docs) {
      const lines: Line[] = [];
      for (const [key, value] of doc.fields) {
        if (value) lines.push(line(value, key));
      }
      for (const text of doc.body.split('\n')) {
        if (text) lines.push(line(text));
      }
      this.entries.set(doc.id, { id: doc.id, title: line(doc.title), lines });
    }
  }

  remove(ids: string[]): void {
    for (const id of ids) this.entries.delete(id);
  }

  search(query: string, options: SearchOptions): SearchResponse {
    if (!query) return { results: [] };
    const needle = options.caseSensitive ? query : query.toLowerCase();
    let finder: Finder;
    try {
      finder = options.regex ? regexFinder(query, options) : textFinder(needle, options);
    } catch (error) {
      return { results: [], error: error instanceof Error ? error.message : String(error) };
    }

    const results: SearchResult[] = [];
    for (const entry of this.entries.values()) {
      const result = searchEntry(entry, finder, needle, options);
      if (result) results.push(result);
    }
    results.sort(
      (a, b) => b.score - a.score || b.count - a.count || collator.compare(a.title, b.title),
    );
    return { results };
  }
}

function pickHaystack(target: Line, caseSensitive: boolean): string {
  // toLowerCase can change length for a few characters (e.g. İ); fall back to raw text then.
  return caseSensitive || target.lower.length !== target.text.length ? target.text : target.lower;
}

function textFinder(needle: string, options: SearchOptions): Finder {
  return {
    ranges(target) {
      const haystack = pickHaystack(target, options.caseSensitive);
      const ranges: SearchRange[] = [];
      for (
        let at = haystack.indexOf(needle);
        at !== -1;
        at = haystack.indexOf(needle, at + needle.length)
      ) {
        ranges.push({ start: at, end: at + needle.length });
      }
      return ranges;
    },
    count(target) {
      const haystack = pickHaystack(target, options.caseSensitive);
      let count = 0;
      for (
        let at = haystack.indexOf(needle);
        at !== -1;
        at = haystack.indexOf(needle, at + needle.length)
      ) {
        count += 1;
      }
      return count;
    },
  };
}

function regexFinder(query: string, options: SearchOptions): Finder {
  const pattern = new RegExp(query, options.caseSensitive ? 'gu' : 'giu');
  return {
    ranges(target) {
      const ranges: SearchRange[] = [];
      for (const match of target.text.matchAll(pattern)) {
        // Empty matches (e.g. `^`) would highlight nothing; skip them.
        if (match[0].length)
          ranges.push({ start: match.index, end: match.index + match[0].length });
      }
      return ranges;
    },
    count(target) {
      let count = 0;
      for (const match of target.text.matchAll(pattern)) {
        if (match[0].length) count += 1;
      }
      return count;
    },
  };
}

function snippet(text: string, ranges: SearchRange[]): SearchMatch {
  const first = ranges[0]?.start ?? 0;
  let start = Math.max(0, first - SNIPPET_BEFORE);
  // Start on a word boundary when one is in reach, rather than mid-word.
  const space = start > 0 ? text.indexOf(' ', start) : -1;
  if (space !== -1 && space < first) start = space + 1;
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  const prefix = start > 0 ? '…' : '';
  const shift = prefix.length - start;
  const raw = text.slice(start, end);
  const trimmed = raw.trimStart();
  const lead = raw.length - trimmed.length;
  return {
    snippet: prefix + trimmed + (end < text.length ? '…' : ''),
    ranges: ranges
      .filter((range) => range.start >= start && range.end <= end)
      .map((range) => ({ start: range.start + shift - lead, end: range.end + shift - lead })),
  };
}

function searchEntry(
  entry: Entry,
  finder: Finder,
  needle: string,
  options: SearchOptions,
): SearchResult | undefined {
  const titleRanges = finder.ranges(entry.title);
  let count = titleRanges.length;
  let score = 0;
  const matches: SearchMatch[] = [];

  if (titleRanges.length) {
    score = 1000;
    if (!options.regex) {
      const title = options.caseSensitive ? entry.title.text : entry.title.lower;
      if (title === needle) score += 1000;
      else if (title.startsWith(needle)) score += 500;
    }
  }

  for (const target of entry.lines) {
    if (matches.length < MAX_MATCHES_PER_CARD) {
      const ranges = finder.ranges(target);
      if (!ranges.length) continue;
      count += ranges.length;
      score = Math.max(score, target.field ? 300 : 100);
      matches.push({ field: target.field, ...snippet(target.text, ranges) });
    } else {
      const hits = finder.count(target);
      if (!hits) continue;
      count += hits;
      score = Math.max(score, target.field ? 300 : 100);
    }
  }

  if (!count) return undefined;
  return {
    id: entry.id,
    title: entry.title.text,
    titleRanges,
    matches,
    count,
    score: score + Math.min(count, 99),
  };
}
