import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
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

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  let output = '';
  while (!output.includes(expected)) {
    const result = await reader.read();
    if (result.done) throw new Error(`Stream ended before ${expected}`);
    output += new TextDecoder().decode(result.value);
  }
  return output;
}

function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = request(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, body }));
    });
    outgoing.once('error', rejectRequest);
    outgoing.end();
  });
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

test('discovers herdr from the active PATH when no path is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const binDirectory = join(root, 'bin');
  const herdrPath = join(binDirectory, 'herdr');
  await mkdir(binDirectory);
  await writeFile(herdrPath, '#!/bin/sh\n');
  await chmod(herdrPath, 0o755);
  const calls: [string, string[]][] = [];
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
    environment: { PATH: binDirectory },
    herdrRun: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'agent' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: {
              agents: [
                {
                  agent_session: { value: 'session-a' },
                  pane_id: 'wA:pT',
                  tab_id: 'wA:t8',
                },
              ],
            },
          }),
        };
      }
      return { stdout: '' };
    },
  });
  try {
    const settings = await fetch(`${companion.url}/settings`);
    assert.deepEqual(await settings.json(), {
      autofocus: false,
      githubEnabled: false,
      herdrEnabled: true,
      jiraEnabled: false,
      linkEnrichment: false,
    });

    const response = await fetch(`${companion.url}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'focus', harness: 'claude', sessionId: 'session-a' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(calls, [
      [herdrPath, ['agent', 'list']],
      [herdrPath, ['agent', 'focus', 'wA:pT']],
      [herdrPath, ['tab', 'focus', 'wA:t8']],
    ]);
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('returns transient Herdr labels for a resolvable session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const boardPath = join(root, 'board');
  const cardPath = join(boardPath, 'card.md');
  await mkdir(boardPath);
  await writeFile(cardPath, '---\nuuid: card-a\n---\n');
  const sessionFile = '/home/.pi/agent/sessions/session-a.jsonl';
  const herdrCalls: string[][] = [];
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
    herdrPath: '/usr/local/bin/herdr',
    herdrRun: async (_command, args) => {
      herdrCalls.push(args);
      if (args[0] === 'agent') {
        return {
          stdout: JSON.stringify({
            result: {
              agents: [
                { agent_session: { value: sessionFile }, tab_id: 'w6:t1E', workspace_id: 'w6' },
              ],
            },
          }),
        };
      }
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
  try {
    await registerBoard(companion.url, 'board-a', boardPath);
    assert.equal(herdrCalls.length, 3, 'frontend connection performs one Herdr state sync');
    await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardPath,
        harness: 'pi',
        sessionId: 'session-a',
        sessionFile,
        status: 'running',
      }),
    });

    const [association] = (await (
      await fetch(`${companion.url}/associations?boardUuid=board-a`)
    ).json()) as Record<string, unknown>[];
    assert.equal(association.herdrWorkspace, 'Frontend');
    assert.equal(association.herdrTab, 'Background Three');
    assert.equal(herdrCalls.length, 3, 'cached state serves known ingress and reads');

    const publishMissing = (status: string) =>
      fetch(`${companion.url}/associations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardPath,
          harness: 'pi',
          sessionId: 'outside-herdr',
          status,
        }),
      });
    await publishMissing('running');
    await publishMissing('idle');
    assert.equal(herdrCalls.length, 6, 'unresolved ingress is synced and negatively cached once');
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

    // An unknown harness, a non-JSON post, and a non-browser preflight all get nothing.
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
    const allowed = await fetch(`${companion.url}/associations`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://subdavis.github.io' },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://subdavis.github.io');
    assert.equal(allowed.headers.get('vary'), 'Origin');
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('restricts browser requests to configured and loopback origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const configFile = join(root, 'companion.json');
  await writeFile(configFile, JSON.stringify({ webOrigin: 'https://mdello.example' }));
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile,
  });

  try {
    const configured = await fetch(`${companion.url}/settings`, {
      headers: { Origin: 'https://mdello.example' },
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.headers.get('access-control-allow-origin'), 'https://mdello.example');
    assert.equal(configured.headers.get('vary'), 'Origin');

    const loopback = await fetch(`${companion.url}/settings`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(loopback.status, 200);
    assert.equal(loopback.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    const denied = await fetch(`${companion.url}/settings`, {
      headers: { Origin: 'https://unexpected.example' },
    });
    assert.equal(denied.status, 403);
    const deniedBody = (await denied.json()) as { error: string };
    assert.match(deniedBody.error, /Origin "https:\/\/unexpected\.example" is not allowed/);
    assert.match(deniedBody.error, /Set "webOrigin"/);
    assert.match(deniedBody.error, new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(deniedBody.error, /restart mdello-companion/);

    const deniedReferer = await fetch(`${companion.url}/settings`, {
      headers: { Referer: 'https://unexpected.example/page' },
    });
    assert.equal(deniedReferer.status, 403);
    assert.match(((await deniedReferer.json()) as { error: string }).error, /Referer/);
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reads and persists autofocus in companion settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const configFile = join(root, 'companion.json');
  await writeFile(
    configFile,
    JSON.stringify({ autofocus: true, webOrigin: 'https://mdello.example' }),
  );
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile,
  });

  try {
    const initial = await fetch(`${companion.url}/settings`);
    assert.equal(((await initial.json()) as { autofocus: boolean }).autofocus, true);

    const saved = await fetch(`${companion.url}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autofocus: false }),
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { autofocus: boolean }).autofocus, false);
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), {
      autofocus: false,
      webOrigin: 'https://mdello.example',
    });

    const invalid = await fetch(`${companion.url}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autofocus: 'yes' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('streams cached URL enrichment, refreshes, polls, and stops on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const configFile = join(root, 'companion.json');
  let calls = 0;
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile,
    githubPath: '/usr/local/bin/gh',
    enrichmentPollIntervalMs: 100,
    githubRun: async () => {
      calls += 1;
      return {
        stdout: JSON.stringify({ number: 12, title: `Feature ${calls}`, state: 'OPEN' }),
      };
    },
  });
  const url = 'https://github.com/owner/repo/pull/12';
  const streamUrl = `${companion.url}/enrichments?${new URLSearchParams({ url })}`;
  const firstController = new AbortController();
  const secondController = new AbortController();

  try {
    const saved = await fetch(`${companion.url}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkEnrichment: true }),
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(await readFile(configFile, 'utf8')).linkEnrichment, true);

    const first = await fetch(streamUrl, { signal: firstController.signal });
    assert.equal(first.headers.get('content-type'), 'text/event-stream');
    const firstReader = first.body?.getReader();
    assert.ok(firstReader);
    const firstEvents = await readUntil(firstReader, 'Feature 1');
    assert.match(firstEvents, /"items":\[\]/);
    await firstReader.cancel();
    firstController.abort();

    const second = await fetch(streamUrl, { signal: secondController.signal });
    const secondReader = second.body?.getReader();
    assert.ok(secondReader);
    const secondEvents = await readUntil(secondReader, 'Feature 2');
    assert.ok(secondEvents.indexOf('Feature 1') < secondEvents.indexOf('Feature 2'));

    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.ok(calls >= 3);
    await secondReader.cancel();
    secondController.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const callsAfterClose = calls;
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(calls, callsAfterClose);
  } finally {
    firstController.abort();
    secondController.abort();
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('streams Jira enrichment under the shared link setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const configFile = join(root, 'companion.json');
  const calls: string[][] = [];
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile,
    jiraPath: '/usr/local/bin/jira',
    jiraRun: async (_command, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          key: 'SCA-1234',
          fields: { summary: 'Add Jira enrichment', status: { name: 'In Progress' } },
        }),
      };
    },
  });
  const issueUrl = 'https://sonarsource.atlassian.net/browse/SCA-1234';
  const controller = new AbortController();

  try {
    const settings = (await (await fetch(`${companion.url}/settings`)).json()) as {
      jiraEnabled: boolean;
    };
    assert.equal(settings.jiraEnabled, true);

    const saved = await fetch(`${companion.url}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkEnrichment: true }),
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(await readFile(configFile, 'utf8')).linkEnrichment, true);

    const query = new URLSearchParams({ url: issueUrl });
    const response = await fetch(`${companion.url}/enrichments?${query}`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const events = await readUntil(reader, 'Add Jira enrichment');
    assert.match(events, /"provider":"jira"/);
    assert.match(events, /"status":"In Progress"/);
    assert.deepEqual(calls[0], ['issue', 'view', 'SCA-1234', '--raw']);
    await reader.cancel();
  } finally {
    controller.abort();
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects browser headers and non-loopback hosts on local hook routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
    configFile: join(root, 'companion.json'),
  });

  try {
    for (const headers of [
      { Origin: 'https://subdavis.github.io' },
      { Referer: 'https://subdavis.github.io/mdello/' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const response = await fetch(`${companion.url}/hooks/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{}',
      });
      assert.equal(response.status, 403);
      assert.match(
        ((await response.json()) as { error: string }).error,
        /local agent hook clients/,
      );
    }

    const rebound = await rawGet(`${companion.url}/settings`, { Host: 'attacker.example' });
    assert.equal(rebound.status, 403);
    const reboundBody = JSON.parse(rebound.body) as { error: string };
    assert.match(reboundBody.error, /Host "attacker\.example"/);
    assert.match(reboundBody.error, /127\.0\.0\.1/);
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
