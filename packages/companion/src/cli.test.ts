import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = new URL('./cli.ts', import.meta.url).pathname;

function environment(dataFile: string, configFile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MDELLO_COMPANION_DATA: dataFile,
    MDELLO_COMPANION_CONFIG: configFile,
  };
}

test('status lists tracked boards and their current event counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-cli-'));
  try {
    const dataFile = join(root, 'companion.jsonl');
    const configFile = join(root, 'companion.json');
    await writeFile(
      configFile,
      JSON.stringify({
        boards: [
          { uuid: 'board-a', path: '/boards/first', updatedAt: '2026-01-01T00:00:00Z' },
          { uuid: 'board-b', path: '/boards/second', updatedAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    );
    await writeFile(
      dataFile,
      [
        {
          boardUuid: 'board-a',
          cardUuid: 'card-a',
          cardPath: '/boards/first/card.md',
          harness: 'pi',
          sessionId: 'session-a',
          status: 'closed',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          boardUuid: 'board-a',
          cardUuid: 'card-b',
          cardPath: '/boards/first/other.md',
          harness: 'pi',
          sessionId: 'session-b',
          status: 'closed',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          boardUuid: 'board-a',
          cardUuid: 'card-b',
          cardPath: '/boards/first/other.md',
          harness: 'pi',
          sessionId: 'session-b',
          status: 'ready_for_review',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const { stdout } = await run(process.execPath, ['--experimental-strip-types', cli, 'status'], {
      env: environment(dataFile, configFile),
    });
    assert.match(stdout, /board-a \/boards\/first: 3 events/);
    assert.match(stdout, /board-b \/boards\/second: 0 events/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('purge resets the JSONL document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-cli-'));
  try {
    const dataFile = join(root, 'companion.jsonl');
    const configFile = join(root, 'companion.json');
    await writeFile(dataFile, '{"stale":true}\n');

    const { stdout } = await run(process.execPath, ['--experimental-strip-types', cli, 'purge'], {
      env: environment(dataFile, configFile),
    });

    assert.match(stdout, /Purged companion session data/);
    assert.equal(await readFile(dataFile, 'utf8'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
