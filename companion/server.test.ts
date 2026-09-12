import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  associationKey,
  createCompanionServer,
  loadAssociationEvents,
  loadAssociations,
  purgeAssociations,
  reconcileAssociations,
} from './server.ts';

function eventsUrl(baseUrl: string, boardUuid: string, boardPath: string): string {
  return `${baseUrl}/events?${new URLSearchParams({ boardUuid, boardPath })}`;
}

async function registerBoard(baseUrl: string, boardUuid: string, boardPath: string): Promise<void> {
  const response = await fetch(eventsUrl(baseUrl, boardUuid, boardPath));
  assert.equal(response.status, 200);
  await response.body?.cancel();
}

test('keys associations by board and card UUID before mutable path', () => {
  const association = {
    boardUuid: 'board-a',
    cardUuid: 'card-a',
    cardPath: '/board/card.md',
    sessionId: 'session-a',
  };

  assert.equal(
    associationKey({ ...association, harness: 'pi' }),
    associationKey({ ...association, cardPath: '/moved/card.md', harness: 'pi' }),
  );
  assert.notEqual(
    associationKey({ ...association, harness: 'pi' }),
    associationKey({ ...association, harness: 'claude-code' }),
  );
});

test('preserves active JSONL event history during board reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const boardPath = join(root, 'board');
    const cardPath = join(boardPath, 'card.md');
    const dataFile = join(root, 'companion.jsonl');
    await mkdir(boardPath);
    await writeFile(cardPath, '---\nuuid: card-a\n---\n');
    const events = ['running', 'ready_for_review'].map((status, index) => ({
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath,
      harness: 'pi',
      sessionId: 'session-a',
      status,
      updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    }));
    await writeFile(dataFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const associations = await loadAssociations(dataFile);

    const result = await reconcileAssociations(dataFile, associations, [
      { uuid: 'board-a', path: boardPath, updatedAt: '2026-01-02T00:00:00.000Z' },
    ]);

    assert.equal(result.purgedAssociations, 0);
    assert.equal((await loadAssociationEvents(dataFile)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reconciles an association after its UUID-identified card moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const boardPath = join(root, 'moved-board');
    const cardPath = join(boardPath, 'renamed.md');
    const dataFile = join(root, 'companion.jsonl');
    await mkdir(boardPath);
    await writeFile(cardPath, '---\nuuid: card-a\n---\n');
    const association = {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: '/old-board/old-name.md',
      harness: 'pi',
      sessionId: 'session-a',
      status: 'closed' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const result = await reconcileAssociations(
      dataFile,
      new Map([[associationKey(association), association]]),
      [{ uuid: 'board-a', path: boardPath, updatedAt: '2026-01-02T00:00:00.000Z' }],
    );

    assert.equal(result.purgedAssociations, 0);
    assert.equal([...result.associations.values()][0]?.cardPath, cardPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves subscribed live associations and defaults a missing harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const boardPath = join(root, 'board');
  const cardPath = join(boardPath, 'card.md');
  await mkdir(boardPath);
  await writeFile(cardPath, '---\nuuid: card-a\n---\n');
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
  });
  try {
    await registerBoard(companion.url, 'board-a', boardPath);

    const response = await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardPath, sessionId: 'session-a', status: 'running' }),
    });

    assert.equal(response.status, 202);
    const association = (await response.json()) as Record<string, unknown>;
    assert.equal(association.boardUuid, 'board-a');
    assert.equal(association.cardUuid, 'card-a');
    assert.equal(association.cardPath, cardPath);
    assert.equal(association.harness, 'unknown');

    const unknown = await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdownPath: join(root, 'elsewhere.md'),
        sessionId: 'session-a',
        status: 'running',
      }),
    });
    assert.equal(unknown.status, 202);
    assert.deepEqual(await unknown.json(), { ignored: true, reason: 'unknown_card' });
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('backfills only the requested board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const sessionsRoot = join(root, 'sessions');
  const firstBoard = join(root, 'first');
  const secondBoard = join(root, 'second');
  const firstCard = join(firstBoard, 'card.md');
  const secondCard = join(secondBoard, 'card.md');
  await Promise.all([mkdir(sessionsRoot), mkdir(firstBoard), mkdir(secondBoard)]);
  await Promise.all([
    writeFile(join(firstBoard, 'mdello.yml'), 'uuid: board-a\n'),
    writeFile(join(secondBoard, 'mdello.yml'), 'uuid: board-b\n'),
    writeFile(firstCard, '---\nuuid: card-a\n---\n'),
    writeFile(secondCard, '---\nuuid: card-b\n---\n'),
    writeFile(
      join(sessionsRoot, 'session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'backfilled-session' })}\n${JSON.stringify({
        type: 'message',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: `Work on ${firstCard}` },
      })}\n`,
    ),
  ]);
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
    sessionsRoot,
  });
  try {
    await registerBoard(companion.url, 'board-a', firstBoard);
    await registerBoard(companion.url, 'board-b', secondBoard);
    for (const [cardPath, sessionId] of [
      [firstCard, 'old-first-session'],
      [secondCard, 'live-second-session'],
    ]) {
      await fetch(`${companion.url}/associations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardPath, sessionId, status: 'running' }),
      });
    }

    const response = await fetch(`${companion.url}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardUuid: 'board-a', boardPath: firstBoard }),
    });
    assert.equal(response.status, 200);

    const associations = (await (await fetch(`${companion.url}/associations`)).json()) as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(
      associations.map(({ boardUuid, sessionId, status }) => ({ boardUuid, sessionId, status })),
      [
        { boardUuid: 'board-b', sessionId: 'live-second-session', status: 'running' },
        { boardUuid: 'board-a', sessionId: 'backfilled-session', status: 'closed' },
      ],
    );
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('requires board context for SSE and filters snapshots and live events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const firstBoard = join(root, 'first');
  const secondBoard = join(root, 'second');
  const firstCard = join(firstBoard, 'card.md');
  const secondCard = join(secondBoard, 'card.md');
  await Promise.all([mkdir(firstBoard), mkdir(secondBoard)]);
  await Promise.all([
    writeFile(firstCard, '---\nuuid: card-a\n---\n'),
    writeFile(secondCard, '---\nuuid: card-b\n---\n'),
  ]);
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
  });
  const controller = new AbortController();
  try {
    await registerBoard(companion.url, 'board-a', firstBoard);
    await registerBoard(companion.url, 'board-b', secondBoard);
    await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardPath: firstCard, sessionId: 'session-a', status: 'running' }),
    });
    await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardPath: secondCard, sessionId: 'session-b', status: 'running' }),
    });

    assert.equal((await fetch(`${companion.url}/events`)).status, 400);
    assert.equal((await fetch(`${companion.url}/events?boardUuid=board-a`)).status, 400);
    assert.equal(
      (
        await fetch(`${companion.url}/boards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: 'board-a', path: firstBoard }),
        })
      ).status,
      404,
    );
    const stream = await fetch(eventsUrl(companion.url, 'board-a', firstBoard), {
      signal: controller.signal,
    });
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"boardUuid":"board-a"/);
    assert.doesNotMatch(initial, /"boardUuid":"board-b"/);

    await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardPath: secondCard, sessionId: 'session-c', status: 'idle' }),
    });
    await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardPath: firstCard, sessionId: 'session-d', status: 'idle' }),
    });
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /"sessionId":"session-d"/);
    assert.doesNotMatch(event, /"sessionId":"session-c"/);
  } finally {
    controller.abort();
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('expunges every card event without touching same card UUID on another board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const dataFile = join(root, 'companion.jsonl');
  const events = [
    {
      boardUuid: 'board-a',
      cardUuid: 'shared-card',
      cardPath: '/first/card.md',
      harness: 'pi',
      sessionId: 'session-a',
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      boardUuid: 'board-a',
      cardUuid: 'shared-card',
      cardPath: '/first/card.md',
      harness: 'pi',
      sessionId: 'session-a',
      status: 'closed',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      boardUuid: 'board-b',
      cardUuid: 'shared-card',
      cardPath: '/second/card.md',
      harness: 'pi',
      sessionId: 'session-b',
      status: 'closed',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  ];
  await writeFile(dataFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const companion = await createCompanionServer({
    port: 0,
    dataFile,
    configFile: join(root, 'companion.json'),
  });
  try {
    const response = await fetch(
      `${companion.url}/associations?boardUuid=board-a&cardUuid=shared-card`,
      { method: 'DELETE' },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removedEvents: 2 });
    const remaining = await loadAssociationEvents(dataFile);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.boardUuid, 'board-b');
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('purges persisted companion session data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const dataFile = join(root, 'companion.jsonl');
    await writeFile(dataFile, '{"sessionId":"stale"}\n');

    await purgeAssociations(dataFile);

    assert.equal(await readFile(dataFile, 'utf8'), '');
    assert.equal((await loadAssociations(dataFile)).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creates missing parent directory when purging companion session data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const dataFile = join(root, 'state', 'companion.jsonl');

    await purgeAssociations(dataFile);

    assert.equal(await readFile(dataFile, 'utf8'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('treats persisted associations without a harness as unknown associations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const dataFile = join(root, 'companion.jsonl');
    await writeFile(
      dataFile,
      `${JSON.stringify({
        cardPath: '/board/card.md',
        sessionId: 'session-a',
        status: 'closed',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })}\n`,
    );

    const associations = await loadAssociations(dataFile);
    assert.equal([...associations.values()][0]?.harness, 'unknown');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
