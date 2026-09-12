import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { backfillAssociations } from './backfill.ts';
import type { Association } from './server.ts';

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

test('backfills missing associations once without replacing live state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-backfill-'));
  try {
    const sessionsRoot = join(root, 'sessions');
    const boardRoot = join(root, 'board');
    const dataFile = join(root, 'state', 'companion.jsonl');
    const firstCard = join(boardRoot, 'first.md');
    const secondCard = join(boardRoot, 'second.md');
    const thirdCard = join(boardRoot, 'third.md');
    const existing: Association = {
      cardPath: firstCard,
      harness: 'pi',
      sessionId: 'session-a',
      status: 'ready_for_review',
      updatedAt: '2026-01-03T00:00:00.000Z',
    };

    await mkdir(join(sessionsRoot, 'project-a'), { recursive: true });
    await mkdir(join(sessionsRoot, 'project-b'), { recursive: true });
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(dataFile, jsonl([existing]));
    await writeFile(
      join(sessionsRoot, 'project-a', 'a.jsonl'),
      `${jsonl([
        {
          type: 'session',
          id: 'session-a',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
        {
          type: 'message',
          timestamp: '2026-01-01T00:01:00.000Z',
          message: { role: 'user', content: `Work on ${firstCard} and ${secondCard}` },
        },
        { type: 'message', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'assistant' } },
      ])}{damaged json}\n`,
    );
    await writeFile(
      join(sessionsRoot, 'project-b', 'b.jsonl'),
      jsonl([
        {
          type: 'session',
          id: 'session-b',
          timestamp: '2026-01-02T00:00:00.000Z',
        },
        {
          type: 'message',
          timestamp: '2026-01-02T00:01:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: `Review '${thirdCard}'` }] },
        },
      ]),
    );

    const first = await backfillAssociations({ sessionsRoot, boardRoot, dataFile });
    assert.deepEqual(first, {
      scannedSessions: 2,
      matchedSessions: 2,
      foundAssociations: 3,
      addedAssociations: 2,
      existingAssociations: 1,
    });

    const associations = (await readFile(dataFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Association);
    assert.equal(associations.length, 3);
    assert.deepEqual(associations[0], existing);
    assert.deepEqual(
      associations.map(({ cardPath, harness, sessionId, status }) => ({
        cardPath,
        harness,
        sessionId,
        status,
      })),
      [
        {
          cardPath: firstCard,
          harness: 'pi',
          sessionId: 'session-a',
          status: 'ready_for_review',
        },
        { cardPath: secondCard, harness: 'pi', sessionId: 'session-a', status: 'closed' },
        { cardPath: thirdCard, harness: 'pi', sessionId: 'session-b', status: 'closed' },
      ],
    );
    assert.equal(associations[1]?.updatedAt, '2026-01-01T00:02:00.000Z');

    const second = await backfillAssociations({ sessionsRoot, boardRoot, dataFile });
    assert.equal(second.addedAssociations, 0);
    assert.equal(second.existingAssociations, 3);
    assert.equal((await readFile(dataFile, 'utf8')).trim().split('\n').length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
