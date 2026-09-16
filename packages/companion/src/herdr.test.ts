import assert from 'node:assert/strict';
import test from 'node:test';
import type { Association } from '@mdello/common/associations';
import { HerdrSessionCache } from './herdr.ts';

const sessionFile = '/home/.pi/agent/sessions/session-a.jsonl';
const association: Association = {
  cardPath: '/board/card.md',
  harness: 'pi',
  sessionId: 'session-a',
  sessionFile,
  status: 'idle',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function fixture() {
  let agents: object[] = [];
  const calls: string[][] = [];
  const cache = new HerdrSessionCache({
    herdrPath: '/usr/local/bin/herdr',
    run: async (_command, args) => {
      calls.push(args);
      if (args[0] === 'agent') return { stdout: JSON.stringify({ result: { agents } }) };
      if (args[0] === 'tab') {
        return {
          stdout: JSON.stringify({
            result: { tabs: [{ tab_id: 'w6:t1E', label: 'Background Three' }] },
          }),
        };
      }
      return {
        stdout: JSON.stringify({
          result: { workspaces: [{ workspace_id: 'w6', label: 'Frontend' }] },
        }),
      };
    },
  });
  return {
    cache,
    calls,
    resolveSession() {
      agents = [{ agent_session: { value: sessionFile }, tab_id: 'w6:t1E', workspace_id: 'w6' }];
    },
  };
}

test('refreshes Herdr once and presents every association from cached state', async () => {
  const { cache, calls, resolveSession } = fixture();
  resolveSession();

  await cache.refresh([association]);
  assert.deepEqual(calls, [
    ['agent', 'list'],
    ['tab', 'list'],
    ['workspace', 'list'],
  ]);
  assert.deepEqual(cache.present([association]), [
    { ...association, herdrWorkspace: 'Frontend', herdrTab: 'Background Three' },
  ]);
  await cache.ensure(association);
  assert.deepEqual(cache.present([association]), [
    { ...association, herdrWorkspace: 'Frontend', herdrTab: 'Background Three' },
  ]);
  assert.equal(calls.length, 3);
});

test('caches unresolved ingress sessions until the next frontend refresh', async () => {
  const { cache, calls, resolveSession } = fixture();

  await cache.ensure(association);
  await cache.ensure(association);
  assert.equal(calls.length, 3);
  assert.deepEqual(cache.present([association]), [association]);

  resolveSession();
  await cache.refresh([association]);
  assert.equal(calls.length, 6);
  assert.deepEqual(cache.present([association]), [
    { ...association, herdrWorkspace: 'Frontend', herdrTab: 'Background Three' },
  ]);
});

test('syncs once when ingress introduces a different unknown session', async () => {
  const { cache, calls } = fixture();
  const other = {
    ...association,
    sessionId: 'session-b',
    sessionFile: '/sessions/session-b.jsonl',
  };

  await cache.ensure(association);
  await cache.ensure(association);
  await cache.ensure(other);
  await cache.ensure(other);

  assert.equal(calls.length, 6);
});
