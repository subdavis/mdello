import assert from 'node:assert/strict';
import test from 'node:test';
import { useDrag } from './useDrag.ts';

test('clearing a no-op reorder slot does not cancel a merge hover', () => {
  const drag = useDrag();
  drag.mergeTarget.value = 'destination';
  drag.target.value = { column: 'Doing', index: 1 };

  drag.clearTarget();

  assert.equal(drag.target.value, null);
  assert.equal(drag.mergeTarget.value, 'destination');
  drag.end();
  assert.equal(drag.mergeTarget.value, null);
});
