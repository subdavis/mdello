import assert from 'node:assert/strict';
import test from 'node:test';
import type { Association } from '@mdello/common/associations';
import { findAdapter, harnessFromPath, hookAssociationInputs, sessionCardPaths } from './hooks.ts';

function association(overrides: Partial<Association>): Association {
  return {
    boardUuid: 'board',
    cardUuid: 'card',
    cardPath: '/board/card.md',
    harness: 'claude',
    sessionId: 's1',
    status: 'running',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('routes only registered harnesses', () => {
  assert.equal(findAdapter('claude')?.harness, 'claude');
  assert.equal(findAdapter('nope'), undefined);
});

test('parses the harness out of a hook path', () => {
  assert.equal(harnessFromPath('/hooks/claude'), 'claude');
  assert.equal(harnessFromPath('/hooks/claude/extra'), undefined);
  assert.equal(harnessFromPath('/hooks/'), undefined);
  assert.equal(harnessFromPath('/associations'), undefined);
});

test('collects a session cards from its own harness only', () => {
  const associations = [
    association({ cardPath: '/board/one.md' }),
    association({ cardPath: '/board/two.md' }),
    association({ cardPath: '/board/dupe.md' }),
    association({ cardPath: '/board/dupe.md', status: 'idle' }),
    association({ cardPath: '/board/other-session.md', sessionId: 's2' }),
    association({ cardPath: '/board/other-harness.md', harness: 'pi' }),
  ];

  assert.deepEqual(sessionCardPaths(associations, 'claude', 's1'), [
    '/board/one.md',
    '/board/two.md',
    '/board/dupe.md',
  ]);
});

test('publishes a status change to discovered and already-known cards alike', () => {
  const inputs = hookAssociationInputs(
    {
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      status: 'ready_for_review',
      cardPaths: ['/board/new.md', '/board/one.md'],
    },
    'claude',
    [association({ cardPath: '/board/one.md' }), association({ cardPath: '/board/two.md' })],
  );

  assert.deepEqual(inputs, [
    {
      markdownPath: '/board/new.md',
      harness: 'claude',
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      status: 'ready_for_review',
    },
    {
      markdownPath: '/board/one.md',
      harness: 'claude',
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      status: 'ready_for_review',
    },
    {
      markdownPath: '/board/two.md',
      harness: 'claude',
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      status: 'ready_for_review',
    },
  ]);
});

test('omits an absent session file rather than sending it as undefined', () => {
  const [input] = hookAssociationInputs(
    { sessionId: 's1', status: 'closed', cardPaths: ['/board/one.md'] },
    'claude',
    [],
  );
  assert.deepEqual(Object.keys(input ?? {}), ['markdownPath', 'harness', 'sessionId', 'status']);
});
