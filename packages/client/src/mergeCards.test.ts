import assert from 'node:assert/strict';
import test from 'node:test';
import { mergedContent } from './mergeCards.ts';

test('appends body with one blank line and unions tags in destination order', () => {
  assert.deepEqual(
    mergedContent(
      { body: 'First\n', tags: ['shared', 'first'] },
      { body: '\nSecond\n', tags: ['shared', 'second'] },
    ),
    { body: 'First\n\nSecond', tags: ['shared', 'first', 'second'] },
  );
});

test('does not insert blank lines for empty bodies', () => {
  assert.equal(mergedContent({ body: '', tags: [] }, { body: 'Second', tags: [] }).body, 'Second');
});
