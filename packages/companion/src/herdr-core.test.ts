import assert from 'node:assert/strict';
import test from 'node:test';
import type { Association } from '@mdello/common/associations';
import { HerdrCoreSessionCache } from './herdr-core.ts';

const association: Association = {
  cardPath: '/board/card.md',
  harness: 'pi',
  sessionId: 'session-a',
  hcTerminal: 't15',
  status: 'idle',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function fixture() {
  const calls: string[][] = [];
  const cache = new HerdrCoreSessionCache({
    herdrCorePath: '/bin/herdr-core',
    run: async (_command, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          terminals: [{ address: 't15', where: 'Agentic & CLI / Tab / 1' }, { address: 't20' }],
        }),
      };
    },
  });
  return { cache, calls };
}

test('labels live terminals from hc ls, splitting space from tab', async () => {
  const { cache, calls } = fixture();
  await cache.refresh();
  assert.deepEqual(calls, [['ls', '--json']]);
  assert.deepEqual(cache.present([association]), [
    { ...association, herdrWorkspace: 'Agentic & CLI', herdrTab: 'Tab / 1' },
  ]);
});

test('keeps Herdr labels, skips closed, hidden, and unknown terminals', async () => {
  const { cache } = fixture();
  await cache.refresh();
  const herdr = { ...association, herdrWorkspace: 'W', herdrTab: 'T' };
  const closed = { ...association, status: 'closed' as const };
  const hidden = { ...association, hcTerminal: 't20' };
  const plain = { ...association, hcTerminal: undefined };
  assert.deepEqual(cache.present([herdr, closed, hidden, plain]), [herdr, closed, hidden, plain]);
});

test('syncs once per unseen terminal until the next refresh', async () => {
  const { cache, calls } = fixture();
  const hidden = { hcTerminal: 't20' };
  await cache.ensure(hidden);
  await cache.ensure(hidden);
  await cache.ensure(association);
  await cache.ensure({});
  assert.equal(calls.length, 1);
  await cache.refresh();
  await cache.ensure(hidden);
  assert.equal(calls.length, 3);
});
