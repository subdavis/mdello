import assert from 'node:assert/strict';
import test from 'node:test';
import { fitSnippet, segments } from './fit.ts';

// One pixel per character keeps the expectations readable.
const measure = (text: string) => text.length;
const text = 'the quick brown fox jumps over the lazy needle and more';
const match = { snippet: text, ranges: [{ start: 40, end: 46 }] };

test('leaves the line alone when everything through the hit fits', () => {
  assert.equal(fitSnippet(match, 46, measure), match);
  assert.equal(fitSnippet(match, 0, measure), match);
});

test('trims a word-aligned lead-in proportional to the width', () => {
  const fitted = fitSnippet(match, 30, measure);
  assert.equal(fitted.snippet, '…the lazy needle and more');
  const [range] = fitted.ranges;
  assert.ok(range);
  assert.equal(fitted.snippet.slice(range.start, range.end), 'needle');

  const wider = fitSnippet(match, 45, measure);
  assert.ok(wider.snippet.length > fitted.snippet.length);
  assert.ok(wider.snippet.startsWith('…'));
});

test('binary-searches the lead-in and segments highlighted ranges', () => {
  let calls = 0;
  const counted = (s: string) => {
    calls += 1;
    return s.length;
  };
  const long = `${'word '.repeat(24)}needle tail`;
  const fitted = fitSnippet({ snippet: long, ranges: [{ start: 120, end: 126 }] }, 36, counted);
  assert.ok(calls <= 10, `expected logarithmic measure calls, got ${calls}`);
  assert.deepEqual(segments(fitted.snippet, fitted.ranges), [
    { text: '…word word ', mark: false },
    { text: 'needle', mark: true },
    { text: ' tail', mark: false },
  ]);
});
