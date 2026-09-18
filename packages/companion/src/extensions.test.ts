import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BoardRegistration, CompanionConfig } from './boards.ts';
import type { DebugLogger } from './debug.ts';
import { type Schedule, startCompanionExtensions } from './extensions.ts';

function companionConfig(value: unknown): Partial<CompanionConfig> {
  return { extensions: { 'github-assignment': value } };
}

function registration(path: string): BoardRegistration {
  return { uuid: 'board-a', path, updatedAt: '2026-09-18T12:00:00Z' };
}

test('schedules configured GitHub assignment sync and stops it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-extensions-'));
  try {
    await writeFile(join(root, 'mdello.yml'), 'uuid: board-a\ncolumns: [Todo, Triage]\n');
    const events: string[] = [];
    let task: (() => Promise<void>) | undefined;
    let blocked: (() => void) | undefined;
    let stopped = false;
    const schedule: Schedule = (pattern, scheduledTask, onBlocked) => {
      assert.equal(pattern, '0 * * * *');
      task = scheduledTask;
      blocked = onBlocked;
      return { stop: () => (stopped = true) };
    };
    const debug: DebugLogger = (message) => events.push(message);

    const extensions = await startCompanionExtensions(
      companionConfig({
        schedule: '0 * * * *',
        organizations: [],
        boardUuid: 'board-a',
      }),
      [registration(root)],
      { debug, schedule, run: async () => ({ stdout: '[]' }) },
    );

    assert.ok(task);
    await task();
    blocked?.();
    extensions.stop();
    assert.equal(stopped, true);
    assert.deepEqual(events, [
      'GitHub assignment extension scheduled',
      'GitHub assignment sync completed',
      'GitHub assignment sync skipped because previous run is active',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves missing configuration disabled', async () => {
  let scheduled = false;
  const extensions = await startCompanionExtensions({}, [], {
    debug: () => {},
    schedule: () => {
      scheduled = true;
      return { stop() {} };
    },
  });
  extensions.stop();
  assert.equal(scheduled, false);
});

test('disables invalid board and column configurations without throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-extensions-'));
  try {
    await writeFile(join(root, 'mdello.yml'), 'uuid: board-a\ncolumns: [Todo]\n');
    const errors: string[] = [];
    const debug: DebugLogger = (message, details) => {
      if (message.endsWith('disabled')) errors.push(String(details?.error));
    };
    const value = { schedule: '0 * * * *', organizations: [], boardUuid: 'board-a' };

    await startCompanionExtensions(companionConfig(value), [], { debug });
    await startCompanionExtensions(companionConfig(value), [registration(root)], { debug });

    assert.match(errors[0], /does not match a registered board/);
    assert.match(errors[1], /has no Triage column/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('disables an invalid cron expression reported by the scheduler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-extensions-'));
  try {
    await writeFile(join(root, 'mdello.yml'), 'uuid: board-a\ncolumns: [Triage]\n');
    const errors: string[] = [];
    await startCompanionExtensions(
      companionConfig({ schedule: 'not cron', organizations: [], boardUuid: 'board-a' }),
      [registration(root)],
      {
        debug: (message, details) => {
          if (message.endsWith('disabled')) errors.push(String(details?.error));
        },
        schedule: () => {
          throw new Error('invalid cron');
        },
      },
    );
    assert.deepEqual(errors, ['invalid cron']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
