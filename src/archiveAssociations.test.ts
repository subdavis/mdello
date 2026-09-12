import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archiveWithSessionAssociations,
  mergeSessionAssociations,
  SESSION_ASSOCIATIONS_KEY,
  type SessionAssociation,
} from './archiveAssociations.ts';
import { parseFile, serializeFile } from './fs/frontmatter.ts';

const first: SessionAssociation = {
  harness: 'pi',
  sessionId: 'session-a',
  status: 'closed',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const updated: SessionAssociation = {
  ...first,
  status: 'ready_for_review',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const second: SessionAssociation = {
  harness: 'claude-code',
  sessionId: 'session-b',
  sessionFile: '/sessions/b.jsonl',
  status: 'closed',
  updatedAt: '2026-01-03T00:00:00.000Z',
};

test('merges multiple session associations without retry duplicates', () => {
  assert.deepEqual(
    mergeSessionAssociations(
      [first],
      [{ ...updated, boardUuid: 'board-a', cardPath: '/board/card.md' }, second, second],
    ),
    [updated, second],
  );
});

test('writes merged session history as valid card frontmatter', async () => {
  const data: Record<string, unknown> = { title: 'Card' };
  await archiveWithSessionAssociations(data, [first, second], {
    persist: async () => {},
    expunge: async () => {},
    move: async () => {},
  });

  const reparsed = parseFile(serializeFile(data, 'Body'));
  assert.deepEqual(reparsed.data[SESSION_ASSOCIATIONS_KEY], [first, second]);
  assert.equal(reparsed.body.trimStart(), 'Body');
});

test('archives a card with no associations without rewriting frontmatter', async () => {
  const data = { title: 'Card' };
  const calls: string[] = [];

  const result = await archiveWithSessionAssociations(data, [], {
    persist: async () => {
      calls.push('persist');
    },
    expunge: async () => {
      calls.push('expunge');
    },
    move: async () => {
      calls.push('move');
      return 'archived';
    },
  });

  assert.equal(result, 'archived');
  assert.deepEqual(data, { title: 'Card' });
  assert.deepEqual(calls, ['expunge', 'move']);
});

test('does not expunge or move when frontmatter persistence fails', async () => {
  const data: Record<string, unknown> = { title: 'Card' };
  let expunged = false;
  let moved = false;

  await assert.rejects(
    archiveWithSessionAssociations(data, [first], {
      persist: async () => {
        throw new Error('disk full');
      },
      expunge: async () => {
        expunged = true;
      },
      move: async () => {
        moved = true;
      },
    }),
    /disk full/,
  );

  assert.equal(data[SESSION_ASSOCIATIONS_KEY], undefined);
  assert.equal(expunged, false);
  assert.equal(moved, false);
});

test('retries safely after companion notification or move failures', async () => {
  const data: Record<string, unknown> = {};
  let persisted = 0;
  let expunged = 0;
  let moved = 0;

  await assert.rejects(
    archiveWithSessionAssociations(data, [first, second], {
      persist: async () => {
        persisted += 1;
      },
      expunge: async () => {
        expunged += 1;
        throw new Error('companion offline');
      },
      move: async () => {
        moved += 1;
      },
    }),
    /companion offline/,
  );
  assert.equal(persisted, 1);
  assert.equal(moved, 0);

  await assert.rejects(
    archiveWithSessionAssociations(data, [first, second], {
      persist: async () => {
        persisted += 1;
      },
      expunge: async () => {
        expunged += 1;
      },
      move: async () => {
        moved += 1;
        throw new Error('move failed');
      },
    }),
    /move failed/,
  );
  assert.equal(persisted, 1);

  await archiveWithSessionAssociations(data, [], {
    persist: async () => {
      persisted += 1;
    },
    expunge: async () => {
      expunged += 1;
    },
    move: async () => {
      moved += 1;
    },
  });

  assert.equal(persisted, 1);
  assert.equal(expunged, 3);
  assert.equal(moved, 2);
  assert.deepEqual(data[SESSION_ASSOCIATIONS_KEY], [first, second]);
});
