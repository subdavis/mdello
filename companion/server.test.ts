import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  associationKey,
  createCompanionServer,
  loadAssociations,
  resetAssociations,
} from './server.ts';

test('includes harness in association identity', () => {
  const association = { cardPath: '/board/card.md', sessionId: 'session-a' };

  assert.notEqual(
    associationKey({ ...association, harness: 'pi' }),
    associationKey({ ...association, harness: 'claude-code' }),
  );
});

test('treats live associations without a harness as unknown associations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  const companion = await createCompanionServer({
    port: 0,
    dataFile: join(root, 'companion.jsonl'),
  });
  try {
    const response = await fetch(`${companion.url}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardPath: '/board/card.md',
        sessionId: 'session-a',
        status: 'running',
      }),
    });

    assert.equal(response.status, 202);
    assert.equal(((await response.json()) as { harness: string }).harness, 'unknown');
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('resets persisted companion session data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const dataFile = join(root, 'companion.jsonl');
    await writeFile(dataFile, '{"sessionId":"stale"}\n');

    await resetAssociations(dataFile);

    assert.equal(await readFile(dataFile, 'utf8'), '');
    assert.equal((await loadAssociations(dataFile)).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('creates missing parent directory when resetting companion session data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-server-'));
  try {
    const dataFile = join(root, 'state', 'companion.jsonl');

    await resetAssociations(dataFile);

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
