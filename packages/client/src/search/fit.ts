import type { SearchRange } from './engine';

export interface Snippet {
  snippet: string;
  ranges: SearchRange[];
}

export interface SearchSegment {
  text: string;
  mark: boolean;
}

/** Share of the row a lead-in may take once the line no longer fits. */
const LEAD_SHARE = 1 / 3;

/**
 * Trims text ahead of the first hit only when the hit would otherwise land past the row's
 * end-ellipsis. The lead-in kept is proportional to the row width, aligned to a word.
 */
export function fitSnippet(
  match: Snippet,
  width: number,
  measure: (text: string) => number,
): Snippet {
  const first = match.ranges[0];
  if (!first || width <= 0 || measure(match.snippet.slice(0, first.end)) <= width) return match;

  const budget = width * LEAD_SHARE;
  let low = 0;
  let high = first.start;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (measure(`…${match.snippet.slice(mid, first.start)}`) <= budget) high = mid;
    else low = mid + 1;
  }
  let cut = low;
  if (cut === 0) return match;

  // Drop a partial leading word when a word boundary is in reach.
  const space = match.snippet[cut - 1] === ' ' ? -1 : match.snippet.indexOf(' ', cut);
  if (space !== -1 && space < first.start) cut = space + 1;
  const shift = 1 - cut;
  return {
    snippet: `…${match.snippet.slice(cut)}`,
    ranges: match.ranges
      .filter((range) => range.start >= cut)
      .map((range) => ({ start: range.start + shift, end: range.end + shift })),
  };
}

export function segments(text: string, ranges: SearchRange[]): SearchSegment[] {
  const output: SearchSegment[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) output.push({ text: text.slice(at, range.start), mark: false });
    output.push({ text: text.slice(range.start, range.end), mark: true });
    at = range.end;
  }
  if (at < text.length) output.push({ text: text.slice(at), mark: false });
  return output;
}
