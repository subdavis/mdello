import type { Card } from './fs/board';

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface SearchRange {
  start: number;
  end: number;
}

export interface SearchMatch {
  field: string;
  text: string;
  ranges: SearchRange[];
  line?: number;
}

export interface SearchResult {
  card: Card;
  matches: SearchMatch[];
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  error?: string;
}

export interface SearchExecutionOptions {
  signal?: AbortSignal;
  yieldEvery?: number;
}

interface SearchLine {
  field: string;
  text: string;
  line?: number;
  weight: number;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayValue).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function searchableLines(card: Card): SearchLine[] {
  const metadata = Object.entries(card.data)
    .filter(([key]) => key !== 'title')
    .map(([key, value]) => ({ field: key, text: `${key}: ${displayValue(value)}`, weight: 250 }));

  return [
    { field: 'title', text: card.title, weight: 600 },
    { field: 'filename', text: card.name, weight: 450 },
    ...metadata,
    ...card.body.split('\n').map((text, index) => ({
      field: 'body',
      text,
      line: index + 1,
      weight: 100,
    })),
  ];
}

function makePattern(query: string, options: SearchOptions): RegExp {
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
}

function findRanges(text: string, pattern: RegExp): SearchRange[] {
  const ranges: SearchRange[] = [];
  pattern.lastIndex = 0;

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }

  return ranges;
}

function scoreLine(line: SearchLine, query: string, options: SearchOptions): number {
  const text = options.caseSensitive ? line.text : line.text.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  let score = line.weight;

  if (!options.regex && line.field === 'title') {
    if (text === needle) score += 500;
    else if (text.startsWith(needle)) score += 250;
  }

  return score;
}

function searchCard(
  card: Card,
  query: string,
  options: SearchOptions,
  pattern: RegExp,
): SearchResult | undefined {
  let score = 0;
  let occurrenceCount = 0;
  const matches = searchableLines(card).flatMap((line): SearchMatch[] => {
    const ranges = findRanges(line.text, pattern);
    if (ranges.length === 0) return [];
    score = Math.max(score, scoreLine(line, query, options));
    occurrenceCount += ranges.length;
    return [{ field: line.field, text: line.text, ranges, line: line.line }];
  });

  score += Math.min(occurrenceCount, 50);
  return matches.length > 0 ? { card, matches, score } : undefined;
}

function sortResults(results: SearchResult[]): void {
  results.sort(
    (left, right) =>
      right.score - left.score ||
      right.matches.length - left.matches.length ||
      left.card.title.localeCompare(right.card.title),
  );
}

function patternError(error: unknown): SearchResponse {
  return {
    results: [],
    error: error instanceof Error ? error.message : 'Invalid regular expression',
  };
}

export function searchCards(cards: Card[], query: string, options: SearchOptions): SearchResponse {
  if (!query) return { results: [] };

  let pattern: RegExp;
  try {
    pattern = makePattern(query, options);
  } catch (error) {
    return patternError(error);
  }

  const results = cards.flatMap((card) => {
    const result = searchCard(card, query, options, pattern);
    return result ? [result] : [];
  });
  sortResults(results);
  return { results };
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function searchCardsAsync(
  cards: Card[],
  query: string,
  options: SearchOptions,
  execution: SearchExecutionOptions = {},
): Promise<SearchResponse> {
  if (!query || execution.signal?.aborted) return { results: [] };

  let pattern: RegExp;
  try {
    pattern = makePattern(query, options);
  } catch (error) {
    return patternError(error);
  }

  const results: SearchResult[] = [];
  const yieldEvery = Math.max(1, execution.yieldEvery ?? 8);

  for (const [index, card] of cards.entries()) {
    if (execution.signal?.aborted) return { results: [] };
    const result = searchCard(card, query, options, pattern);
    if (result) results.push(result);

    if ((index + 1) % yieldEvery === 0 && index + 1 < cards.length) {
      await yieldToMainThread();
    }
  }

  if (execution.signal?.aborted) return { results: [] };
  sortResults(results);
  return { results };
}
