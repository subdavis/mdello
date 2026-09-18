import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { backfillAssociations } from './backfill.ts';
import type { Association } from './server.ts';

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

async function writeCard(path: string, uuid: string): Promise<void> {
  await writeFile(path, `---\nuuid: ${uuid}\n---\n`);
}

test('backfills all registered boards while preserving live statuses and other harnesses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-backfill-'));
  try {
    const sessionsRoot = join(root, 'sessions');
    const boardRoot = join(root, 'board');
    const otherBoardRoot = join(root, 'other-board');
    const dataFile = join(root, 'state', 'companion.jsonl');
    const configFile = join(root, 'state', 'companion.json');
    const firstCard = join(boardRoot, 'first.md');
    const secondCard = join(boardRoot, 'second.md');
    const thirdCard = join(otherBoardRoot, 'third.md');
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
      cardPath: join(otherBoardRoot, 'card.md'),
      harness: 'claude',
      sessionId: 'other-session',
      status: 'running',
      updatedAt: '2026-01-04T00:00:00.000Z',
    };

    await mkdir(join(sessionsRoot, 'project-a'), { recursive: true });
    await mkdir(join(sessionsRoot, 'project-b'), { recursive: true });
    await mkdir(boardRoot, { recursive: true });
    await mkdir(otherBoardRoot, { recursive: true });
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(
      configFile,
      JSON.stringify({
        boards: [
          { uuid: 'board-a', path: boardRoot, updatedAt: '2026-01-01T00:00:00.000Z' },
          { uuid: 'board-b', path: otherBoardRoot, updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    );
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
      harness: 'pi',
      sessionsRoot,
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
        .filter(({ harness }) => harness === 'pi')
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
          boardUuid: 'board-b',
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

    const second = await backfillAssociations({
      harness: 'pi',
      sessionsRoot,
      dataFile,
      configFile,
    });
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

test('recovers Claude Code transcripts and leaves another harness alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-backfill-'));
  try {
    const sessionsRoot = join(root, 'projects', '-Users-someone-board');
    const boardRoot = join(root, 'board');
    const dataFile = join(root, 'companion.jsonl');
    const configFile = join(root, 'companion.json');
    const promptedCard = join(boardRoot, 'prompted.md');
    const writtenCard = join(boardRoot, 'written.md');
    const failedCard = join(boardRoot, 'failed.md');
    const piAssociation: Association = {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: promptedCard,
      harness: 'pi',
      sessionId: 'pi-session',
      status: 'running',
      updatedAt: '2026-01-09T00:00:00.000Z',
    };

    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(boardRoot, { recursive: true });
    await writeFile(
      configFile,
      JSON.stringify({
        boards: [{ uuid: 'board-a', path: boardRoot, updatedAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    await Promise.all([
      writeCard(promptedCard, 'card-a'),
      writeCard(writtenCard, 'card-b'),
      writeCard(failedCard, 'card-c'),
    ]);
    await writeFile(dataFile, jsonl([piAssociation]));

    // Claude repeats identity on every entry and wraps tool calls in content blocks.
    const entry = (type: string, timestamp: string, message: unknown) => ({
      type,
      sessionId: 'claude-session',
      cwd: boardRoot,
      timestamp,
      message,
    });
    await writeFile(
      join(sessionsRoot, 'claude-session.jsonl'),
      jsonl([
        { type: 'mode', sessionId: 'claude-session', mode: 'default' },
        entry('user', '2026-01-10T00:00:00.000Z', {
          role: 'user',
          content: `Work on ${promptedCard}`,
        }),
        entry('assistant', '2026-01-10T00:01:00.000Z', {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-1', name: 'Write', input: { file_path: writtenCard } },
            { type: 'tool_use', id: 'call-2', name: 'Edit', input: { file_path: failedCard } },
          ],
        }),
        entry('user', '2026-01-10T00:02:00.000Z', {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1' },
            { type: 'tool_result', tool_use_id: 'call-2', is_error: true },
          ],
        }),
      ]),
    );

    const result = await backfillAssociations({
      harness: 'claude',
      sessionsRoot,
      dataFile,
      configFile,
    });
    assert.deepEqual(result, {
      scannedSessions: 1,
      matchedSessions: 1,
      foundAssociations: 2,
      addedAssociations: 2,
      existingAssociations: 0,
      purgedAssociations: 0,
    });

    const associations = (await readFile(dataFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Association);
    assert.deepEqual(associations[0], piAssociation, 'the Pi record survives untouched');
    assert.deepEqual(
      associations.slice(1).map(({ cardUuid, harness, sessionId, status, updatedAt }) => ({
        cardUuid,
        harness,
        sessionId,
        status,
        updatedAt,
      })),
      [
        {
          cardUuid: 'card-a',
          harness: 'claude',
          sessionId: 'claude-session',
          status: 'closed',
          updatedAt: '2026-01-10T00:02:00.000Z',
        },
        {
          cardUuid: 'card-b',
          harness: 'claude',
          sessionId: 'claude-session',
          status: 'closed',
          updatedAt: '2026-01-10T00:02:00.000Z',
        },
      ],
      'the failed edit is not associated, and the latest entry dates the session',
    );
    assert.equal(associations[1]?.sessionFile, join(sessionsRoot, 'claude-session.jsonl'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers OpenCode prompts and completed Markdown modifications from SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-backfill-'));
  try {
    const boardRoot = join(root, 'board');
    const databasePath = join(root, 'opencode.db');
    const dataFile = join(root, 'companion.jsonl');
    const configFile = join(root, 'companion.json');
    const promptedCard = join(boardRoot, 'prompted.md');
    const writtenCard = join(boardRoot, 'written.md');
    await mkdir(boardRoot);
    await Promise.all([
      writeCard(promptedCard, 'card-a'),
      writeCard(writtenCard, 'card-b'),
      writeFile(
        configFile,
        JSON.stringify({
          boards: [{ uuid: 'board-a', path: boardRoot, updatedAt: '2026-01-01T00:00:00.000Z' }],
        }),
      ),
    ]);

    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
    `);
    database
      .prepare('INSERT INTO session VALUES (?, ?, ?)')
      .run('ses_123', boardRoot, Date.parse('2026-01-10T00:03:00.000Z'));
    database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run('msg-user', 'ses_123', 1, JSON.stringify({ role: 'user' }));
    database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run('msg-agent', 'ses_123', 2, JSON.stringify({ role: 'assistant' }));
    const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?)');
    insertPart.run(
      'part-prompt',
      'msg-user',
      1,
      JSON.stringify({ type: 'text', text: `Work on ${promptedCard}` }),
    );
    insertPart.run(
      'part-write',
      'msg-agent',
      2,
      JSON.stringify({
        type: 'tool',
        tool: 'write',
        state: { status: 'completed', input: { filePath: 'written.md' } },
      }),
    );
    insertPart.run(
      'part-failed',
      'msg-agent',
      3,
      JSON.stringify({
        type: 'tool',
        tool: 'edit',
        state: { status: 'error', input: { filePath: 'failed.md' } },
      }),
    );
    database.close();

    const result = await backfillAssociations({
      harness: 'opencode',
      sessionsRoot: databasePath,
      dataFile,
      configFile,
      now: new Date('2026-01-15'),
    });
    assert.deepEqual(result, {
      scannedSessions: 1,
      matchedSessions: 1,
      foundAssociations: 2,
      addedAssociations: 2,
      existingAssociations: 0,
      purgedAssociations: 0,
    });

    const associations = (await readFile(dataFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Association);
    assert.deepEqual(
      associations.map(({ cardUuid, harness, sessionId, sessionFile, updatedAt }) => ({
        cardUuid,
        harness,
        sessionId,
        sessionFile,
        updatedAt,
      })),
      [
        {
          cardUuid: 'card-a',
          harness: 'opencode',
          sessionId: 'ses_123',
          sessionFile: databasePath,
          updatedAt: '2026-01-10T00:03:00.000Z',
        },
        {
          cardUuid: 'card-b',
          harness: 'opencode',
          sessionId: 'ses_123',
          sessionFile: databasePath,
          updatedAt: '2026-01-10T00:03:00.000Z',
        },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports no sessions when a harness has never been installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-backfill-'));
  try {
    const configFile = join(root, 'companion.json');
    await writeFile(configFile, JSON.stringify({ boards: [] }));

    const result = await backfillAssociations({
      harness: 'claude',
      sessionsRoot: join(root, 'absent'),
      dataFile: join(root, 'companion.jsonl'),
      configFile,
    });

    assert.equal(result.scannedSessions, 0);
    const opencodeResult = await backfillAssociations({
      harness: 'opencode',
      sessionsRoot: join(root, 'absent.db'),
      dataFile: join(root, 'companion.jsonl'),
      configFile,
    });
    assert.equal(opencodeResult.scannedSessions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a harness it cannot scan', async () => {
  await assert.rejects(
    backfillAssociations({ harness: 'nope', sessionsRoot: '/nowhere' }),
    /unknown harness: nope/,
  );
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
    const configFile = join(root, 'companion.json');
    await writeFile(
      configFile,
      JSON.stringify({
        boards: [{ uuid: 'board-a', path: boardRoot, updatedAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    await writeFile(sessionFile, jsonl([{ type: 'session', id: 'old-session' }]));
    await utimes(sessionFile, new Date('2026-01-01'), new Date('2026-01-01'));

    const result = await backfillAssociations({
      harness: 'pi',
      sessionsRoot,
      dataFile: join(root, 'companion.jsonl'),
      configFile,
      now: new Date('2026-02-15'),
    });

    assert.equal(result.scannedSessions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
