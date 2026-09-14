import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  associationKey,
  createCompanionServer,
  isCompanionListening,
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

test('keys associations by global card UUID before mutable board and path', () => {
  const association = {
    boardUuid: 'board-a',
    cardUuid: 'card-a',
    cardPath: '/board/card.md',
    sessionId: 'session-a',
  };

  const moved = {
    ...association,
    boardUuid: 'board-b',
    cardPath: '/moved/card.md',
    harness: 'pi',
  };
  assert.equal(associationKey({ ...association, harness: 'pi' }), associationKey(moved));
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

test('reconciles an association after its UUID-identified card moves between boards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const oldBoardPath = join(root, 'old-board');
    const boardPath = join(root, 'new-board');
    const cardPath = join(boardPath, 'renamed.md');
    const dataFile = join(root, 'companion.jsonl');
    await Promise.all([mkdir(oldBoardPath), mkdir(boardPath)]);
    await writeFile(cardPath, '---\nuuid: card-a\n---\n');
    const association = {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: join(oldBoardPath, 'old-name.md'),
      harness: 'pi',
      sessionId: 'session-a',
      status: 'closed' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const result = await reconcileAssociations(
      dataFile,
      new Map([[associationKey(association), association]]),
      [
        { uuid: 'board-a', path: oldBoardPath, updatedAt: '2026-01-02T00:00:00.000Z' },
        { uuid: 'board-b', path: boardPath, updatedAt: '2026-01-02T00:00:00.000Z' },
      ],
    );

    assert.equal(result.purgedAssociations, 0);
    assert.deepEqual(
      [...result.associations.values()].map(({ boardUuid, cardPath: path }) => ({
        boardUuid,
        cardPath: path,
      })),
      [{ boardUuid: 'board-b', cardPath }],
    );
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

test('appends nothing when a republished status only moves the timestamp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const boardPath = join(root, 'board');
  const cardPath = join(boardPath, 'card.md');
  const dataFile = join(root, 'companion.jsonl');
  await mkdir(boardPath);
  await writeFile(cardPath, '---\nuuid: card-a\n---\n');
  const companion = await createCompanionServer({
    port: 0,
    dataFile,
    configFile: join(root, 'companion.json'),
  });
  const publish = (body: Record<string, unknown>) =>
    fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardPath, sessionId: 'session-a', harness: 'pi', ...body }),
    });

  try {
    await registerBoard(companion.url, 'board-a', boardPath);

    const first = await publish({ status: 'running' });
    const repeat = await publish({ status: 'running' });
    assert.deepEqual(await repeat.json(), await first.json(), 'the stored record is echoed back');
    assert.equal((await loadAssociationEvents(dataFile)).length, 1);

    // A real status change still lands, and so does a field the log did not have yet.
    await publish({ status: 'ready_for_review' });
    await publish({ status: 'ready_for_review', sessionFile: join(root, 'session.jsonl') });
    await publish({ status: 'ready_for_review', sessionFile: join(root, 'session.jsonl') });
    const events = await loadAssociationEvents(dataFile);
    assert.deepEqual(
      events.map((event) => [event.status, event.sessionFile]),
      [
        ['running', undefined],
        ['ready_for_review', undefined],
        ['ready_for_review', join(root, 'session.jsonl')],
      ],
    );
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('publishes a harness hook payload to the whole session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const boardPath = join(root, 'board');
  const cardPath = join(boardPath, 'card.md');
  const otherPath = join(boardPath, 'other.md');
  await mkdir(boardPath);
  await writeFile(cardPath, '---\nuuid: card-a\n---\n');
  await writeFile(otherPath, '---\nuuid: card-b\n---\n');
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
  });
  const hook = (payload: unknown, headers: Record<string, string> = {}) =>
    fetch(`${companion.url}/hooks/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });

  try {
    await registerBoard(companion.url, 'board-a', boardPath);

    const discovered = await hook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-a',
      transcript_path: join(root, 'session.jsonl'),
      prompt: `work on ${cardPath} and ${otherPath}`,
    });
    assert.equal(discovered.status, 202);
    assert.deepEqual(await discovered.json(), {}, 'hook replies with an inert JSON body');

    // A later event carries no paths, yet must move every card the session touched.
    assert.equal((await hook({ hook_event_name: 'Stop', session_id: 'session-a' })).status, 202);
    const associations = (await (await fetch(`${companion.url}/associations`)).json()) as {
      cardPath: string;
      harness: string;
      status: string;
      sessionFile?: string;
    }[];
    assert.deepEqual(
      associations
        .map((association) => [association.cardPath, association.status])
        .sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? '')),
      [
        [cardPath, 'ready_for_review'],
        [otherPath, 'ready_for_review'],
      ].sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? '')),
    );
    assert.equal(associations[0]?.harness, 'claude');
    assert.equal(associations[0]?.sessionFile, join(root, 'session.jsonl'));

    // An unknown harness, a non-JSON post, and a browser preflight all get nothing.
    assert.equal((await hook({}, {})).status, 202);
    assert.equal(
      (
        await fetch(`${companion.url}/hooks/nope`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      404,
    );
    const simple = await fetch(`${companion.url}/hooks/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-a' }),
    });
    assert.equal(simple.status, 415, 'a request a browser could send without preflight is refused');
    const preflight = await fetch(`${companion.url}/hooks/claude`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 404);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    const allowed = await fetch(`${companion.url}/associations`, { method: 'OPTIONS' });
    assert.equal(allowed.headers.get('access-control-allow-origin'), '*');
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Backfill rewrites the whole log, so it is a CLI maintenance command and not reachable over HTTP.
test('serves no backfill route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
  });
  try {
    const response = await fetch(`${companion.url}/backfill`, { method: 'POST' });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('detects a listening companion so offline commands can refuse to run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
  });
  const port = Number(new URL(companion.url).port);
  try {
    assert.equal(await isCompanionListening(port), true);
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(await isCompanionListening(port), false, 'a closed port reads as not listening');
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

test('expunges every event for a global card UUID', async () => {
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
    const response = await fetch(`${companion.url}/associations?cardUuid=shared-card`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removedEvents: 3 });
    assert.deepEqual(await loadAssociationEvents(dataFile), []);
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('forgets a session from only the selected card', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const dataFile = join(root, 'companion.jsonl');
  const events = [
    {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: '/board/card-a.md',
      harness: 'pi',
      sessionId: 'shared-session',
      status: 'closed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      boardUuid: 'board-a',
      cardUuid: 'card-b',
      cardPath: '/board/card-b.md',
      harness: 'pi',
      sessionId: 'shared-session',
      status: 'idle',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: '/board/card-a.md',
      harness: 'claude',
      sessionId: 'shared-session',
      status: 'idle',
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
    const query = new URLSearchParams({
      cardUuid: 'card-a',
      harness: 'pi',
      sessionId: 'shared-session',
    });
    const response = await fetch(`${companion.url}/associations?${query}`, { method: 'DELETE' });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removedEvents: 1 });
    const persisted = await loadAssociationEvents(dataFile);
    assert.deepEqual(
      persisted.map(({ cardUuid, harness }) => ({ cardUuid, harness })),
      [
        { cardUuid: 'card-b', harness: 'pi' },
        { cardUuid: 'card-a', harness: 'claude' },
      ],
    );
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('forgets a session across cards without removing the same ID from another harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const dataFile = join(root, 'companion.jsonl');
  const events = [
    {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: '/board/card-a.md',
      harness: 'pi',
      sessionId: 'shared-session',
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: '/board/card-a.md',
      harness: 'pi',
      sessionId: 'shared-session',
      status: 'closed',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      boardUuid: 'board-a',
      cardUuid: 'card-b',
      cardPath: '/board/card-b.md',
      harness: 'pi',
      sessionId: 'shared-session',
      status: 'idle',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    {
      boardUuid: 'board-a',
      cardUuid: 'card-a',
      cardPath: '/board/card-a.md',
      harness: 'claude',
      sessionId: 'shared-session',
      status: 'idle',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
  ];
  await writeFile(dataFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const companion = await createCompanionServer({
    port: 0,
    dataFile,
    configFile: join(root, 'companion.json'),
  });
  try {
    const query = new URLSearchParams({ harness: 'pi', sessionId: 'shared-session' });
    const response = await fetch(`${companion.url}/associations?${query}`, { method: 'DELETE' });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removedEvents: 3 });
    const persisted = await loadAssociationEvents(dataFile);
    assert.deepEqual(
      persisted.map(({ harness, sessionId }) => ({ harness, sessionId })),
      [{ harness: 'claude', sessionId: 'shared-session' }],
    );
    const live = (await (await fetch(`${companion.url}/associations`)).json()) as typeof events;
    assert.deepEqual(
      live.map(({ harness, sessionId }) => ({ harness, sessionId })),
      [{ harness: 'claude', sessionId: 'shared-session' }],
    );
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
