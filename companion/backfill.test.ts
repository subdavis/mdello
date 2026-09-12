import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { backfillAssociations } from './backfill.ts';
import type { Association } from './server.ts';

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

async function writeCard(path: string, uuid: string): Promise<void> {
  await writeFile(path, `---\nuuid: ${uuid}\n---\n`);
}

test('replaces one board backfill while preserving live statuses and other boards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-backfill-'));
  try {
    const sessionsRoot = join(root, 'sessions');
    const boardRoot = join(root, 'board');
    const dataFile = join(root, 'state', 'companion.jsonl');
    const configFile = join(root, 'state', 'companion.json');
    const firstCard = join(boardRoot, 'first.md');
    const secondCard = join(boardRoot, 'second.md');
    const thirdCard = join(boardRoot, 'third.md');
    const writtenCard = join(boardRoot, 'written.md');
    const existing: Association = {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: firstCard,
      harness: 'pi',
      sessionId: 'session-a',
      status: 'ready_for_review',
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    const stale: Association = {
      boardUuid: 'board-a',
      cardUuid: 'deleted-card',
      cardPath: join(boardRoot, 'deleted.md'),
      harness: 'pi',
      sessionId: 'old-session',
      status: 'closed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const otherBoard: Association = {
      boardUuid: 'board-b',
      cardUuid: 'card-z',
      cardPath: join(root, 'other-board', 'card.md'),
      harness: 'pi',
      sessionId: 'other-session',
      status: 'running',
      updatedAt: '2026-01-04T00:00:00.000Z',
    };

    await mkdir(join(sessionsRoot, 'project-a'), { recursive: true });
    await mkdir(join(sessionsRoot, 'project-b'), { recursive: true });
    await mkdir(boardRoot, { recursive: true });
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(join(boardRoot, 'mdello.yml'), 'uuid: board-a\n');
    await Promise.all([
      writeCard(firstCard, 'card-a'),
      writeCard(secondCard, 'card-b'),
      writeCard(thirdCard, 'card-c'),
      writeCard(writtenCard, 'card-d'),
    ]);
    await writeFile(dataFile, jsonl([otherBoard, existing, stale]));
    await writeFile(
      join(sessionsRoot, 'project-a', 'a.jsonl'),
      `${jsonl([
        { type: 'session', id: 'session-a', timestamp: '2026-01-01T00:00:00.000Z' },
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
        { type: 'session', id: 'session-b', timestamp: '2026-01-02T00:00:00.000Z' },
        {
          type: 'message',
          timestamp: '2026-01-02T00:01:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: `Review '${thirdCard}'` }] },
        },
        {
          type: 'message',
          timestamp: '2026-01-02T00:02:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'write-card',
                name: 'write',
                arguments: { path: writtenCard, content: 'updated' },
              },
            ],
          },
        },
        {
          type: 'message',
          timestamp: '2026-01-02T00:03:00.000Z',
          message: {
            role: 'toolResult',
            toolName: 'write',
            toolCallId: 'write-card',
            isError: false,
          },
        },
      ]),
    );

    const first = await backfillAssociations({
      sessionsRoot,
      boardRoot,
      dataFile,
      configFile,
    });
    assert.deepEqual(first, {
      scannedSessions: 2,
      matchedSessions: 2,
      foundAssociations: 4,
      addedAssociations: 3,
      existingAssociations: 1,
      purgedAssociations: 1,
    });

    const associations = (await readFile(dataFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Association);
    assert.equal(associations.length, 5);
    assert.deepEqual(associations[0], otherBoard);
    assert.deepEqual(
      associations
        .filter(({ boardUuid }) => boardUuid === 'board-a')
        .map(({ boardUuid, cardUuid, harness, sessionId, status }) => ({
          boardUuid,
          cardUuid,
          harness,
          sessionId,
          status,
        })),
      [
        {
          boardUuid: 'board-a',
          cardUuid: 'card-a',
          harness: 'pi',
          sessionId: 'session-a',
          status: 'ready_for_review',
        },
        {
          boardUuid: 'board-a',
          cardUuid: 'card-b',
          harness: 'pi',
          sessionId: 'session-a',
          status: 'closed',
        },
        {
          boardUuid: 'board-a',
          cardUuid: 'card-c',
          harness: 'pi',
          sessionId: 'session-b',
          status: 'closed',
        },
        {
          boardUuid: 'board-a',
          cardUuid: 'card-d',
          harness: 'pi',
          sessionId: 'session-b',
          status: 'closed',
        },
      ],
    );

    const second = await backfillAssociations({ sessionsRoot, boardRoot, dataFile, configFile });
    assert.equal(second.addedAssociations, 0);
    assert.equal(second.existingAssociations, 4);
    assert.equal(second.purgedAssociations, 0);
    const secondAssociations = (await readFile(dataFile, 'utf8')).trim().split('\n');
    assert.equal(secondAssociations.length, 5);
    assert.deepEqual(JSON.parse(secondAssociations[0] ?? ''), otherBoard);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not scan Pi sessions older than 30 days', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-backfill-'));
  try {
    const sessionsRoot = join(root, 'sessions');
    const boardRoot = join(root, 'board');
    const sessionFile = join(sessionsRoot, 'old.jsonl');
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(boardRoot);
    await writeFile(join(boardRoot, 'mdello.yml'), 'uuid: board-a\n');
    await writeCard(join(boardRoot, 'card.md'), 'card-a');
    await writeFile(sessionFile, jsonl([{ type: 'session', id: 'old-session' }]));
    await utimes(sessionFile, new Date('2026-01-01'), new Date('2026-01-01'));

    const result = await backfillAssociations({
      sessionsRoot,
      boardRoot,
      dataFile: join(root, 'companion.jsonl'),
      configFile: join(root, 'companion.json'),
      now: new Date('2026-02-15'),
    });

    assert.equal(result.scannedSessions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
