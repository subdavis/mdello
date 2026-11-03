import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelativeStamp } from './format.ts';

const now = Date.parse('2026-10-31T12:00:00Z');

test('formats relative timestamps at minute, hour, and day boundaries', () => {
  for (const [minutes, expected] of [
    [0, 'now'],
    [1, '1m'],
    [59, '59m'],
    [60, '1h'],
    [1140, '19h'],
    [1440, '1d'],
    [10080, '1w'],
    [43200, '1mo'],
    [525600, '1y'],
  ] as const) {
    const timestamp = now - minutes * 60_000;
    assert.equal(formatRelativeStamp(timestamp, now), expected);
    assert.equal(formatRelativeStamp(new Date(timestamp).toISOString(), now), expected);
  }
});

test('handles missing, invalid, and future relative timestamps', () => {
  assert.equal(formatRelativeStamp(undefined, now), '—');
  assert.equal(formatRelativeStamp('', now), '—');
  assert.equal(formatRelativeStamp('invalid', now), '—');
  assert.equal(formatRelativeStamp(Number.NaN, now), '—');
  assert.equal(formatRelativeStamp(now + 60_000, now), 'now');
});
