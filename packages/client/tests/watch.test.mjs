import assert from 'node:assert/strict';
import test from 'node:test';
import { changePaths } from '../src/fs/watch.ts';

test('a move reports both its new and old paths', () => {
  assert.deepEqual(
    changePaths({
      type: 'moved',
      relativePathComponents: ['archive', '2026-08', 'card.md'],
      relativePathMovedFrom: ['card.md'],
    }),
    [['archive', '2026-08', 'card.md'], ['card.md']],
  );
});
