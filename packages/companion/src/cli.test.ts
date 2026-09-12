import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createCompanionServer } from './server.ts';

const run = promisify(execFile);
const cli = new URL('./cli.ts', import.meta.url).pathname;

/** Port 1 is never served, so a probing command must not find the developer's own companion. */
function environment(dataFile: string, configFile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MDELLO_COMPANION_DATA: dataFile,
    MDELLO_COMPANION_CONFIG: configFile,
    MDELLO_COMPANION_PORT: '1',
  };
}

interface CommandFailure {
  code: number;
  stderr: string;
}

async function runFailure(args: string[], env: NodeJS.ProcessEnv): Promise<CommandFailure> {
  try {
    await run(process.execPath, ['--experimental-strip-types', cli, ...args], { env });
  } catch (error) {
    return error as CommandFailure;
  }
  throw new Error(`Expected "${args.join(' ')}" to fail`);
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

test('backfill recovers one named harness from its sessions directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-cli-'));
  try {
    const dataFile = join(root, 'companion.jsonl');
    const configFile = join(root, 'companion.json');
    const boardRoot = join(root, 'board');
    const sessionsRoot = join(root, 'projects');
    const cardPath = join(boardRoot, 'card.md');
    await mkdir(boardRoot);
    await mkdir(sessionsRoot);
    await writeFile(cardPath, '---\nuuid: card-a\n---\n');
    await writeFile(
      configFile,
      JSON.stringify({
        boards: [{ uuid: 'board-a', path: boardRoot, updatedAt: '2026-01-01T00:00:00Z' }],
      }),
    );
    await writeFile(
      join(sessionsRoot, 'claude-session.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-session',
        cwd: boardRoot,
        timestamp: '2026-01-10T00:00:00.000Z',
        message: { role: 'user', content: `Work on ${cardPath}` },
      })}\n`,
    );

    const { stdout } = await run(
      process.execPath,
      ['--experimental-strip-types', cli, 'backfill', 'claude'],
      { env: { ...environment(dataFile, configFile), CLAUDE_SESSIONS_DIR: sessionsRoot } },
    );

    assert.match(stdout, /^claude: scanned 1 sessions/);
    assert.match(stdout, /Added 1;/);
    const written = JSON.parse((await readFile(dataFile, 'utf8')).trim()) as Record<
      string,
      unknown
    >;
    assert.equal(written.harness, 'claude');
    assert.equal(written.cardUuid, 'card-a');
    assert.equal(written.status, 'closed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backfill rejects an unknown harness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-cli-'));
  try {
    const failure = await runFailure(
      ['backfill', 'bogus'],
      environment(join(root, 'companion.jsonl'), join(root, 'companion.json')),
    );
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Usage: mdello-companion backfill \[claude\|pi\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backfill refuses to run while a companion holds the port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-cli-'));
  const dataFile = join(root, 'companion.jsonl');
  const configFile = join(root, 'companion.json');
  const companion = await createCompanionServer({ port: 0, dataFile, configFile });
  try {
    await writeFile(dataFile, '');
    const failure = await runFailure(['backfill'], {
      ...environment(dataFile, configFile),
      MDELLO_COMPANION_PORT: new URL(companion.url).port,
    });
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /A companion is listening on port \d+\. Stop it first/);
    assert.equal(await readFile(dataFile, 'utf8'), '', 'the log is left untouched');
  } finally {
    await companion.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('help lists every command and configuration variable', async () => {
  for (const flag of ['help', '-h', '--help']) {
    const { stdout } = await run(process.execPath, ['--experimental-strip-types', cli, flag], {
      env: process.env,
    });
    assert.match(stdout, /^ {2}serve {2,}Start the sidecar/m);
    assert.match(stdout, /^ {2}backfill \[claude\|pi\] {2,}Rebuild associations/m);
    assert.match(stdout, /^ {2}uninstall \[macos\|pi\|claude\] {2,}Remove/m);
    assert.match(stdout, /^ {2}MDELLO_COMPANION_PORT {2,}Listen port \(31337\)$/m);
    assert.match(stdout, /^ {2}PI_SESSIONS_DIR {2,}pi sessions read by backfill/m);
  }
});

test('an unknown command prints the help text and fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-cli-'));
  try {
    const failure = await runFailure(
      ['bogus'],
      environment(join(root, 'companion.jsonl'), join(root, 'companion.json')),
    );
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /^Unknown command "bogus"\./);
    assert.match(failure.stderr, /^ {2}serve {2,}Start the sidecar/m);
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
