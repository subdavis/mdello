import assert from 'node:assert/strict';
import test from 'node:test';
import type { Association } from '@mdello/common/associations';
import { sessionLabel } from './sessionLabel.ts';

const association: Association = {
  cardPath: '/board/card.md',
  harness: 'pi',
  sessionId: '01a0abcb-1010-71ae-9d0b-40f93ba04322',
  status: 'idle',
  updatedAt: '2026-09-16T00:00:00.000Z',
};

test('uses Herdr workspace and tab labels when both resolve', () => {
  assert.equal(
    sessionLabel({
      ...association,
      herdrWorkspace: 'Frontend',
      herdrTab: 'Background Three',
    }),
    'pi:Frontend:Background Three',
  );
});

test('uses the full session id when Herdr labels do not resolve', () => {
  assert.equal(sessionLabel(association), `pi:${association.sessionId}`);
  assert.equal(
    sessionLabel({ ...association, herdrWorkspace: 'Frontend' }),
    `pi:${association.sessionId}`,
  );
});
