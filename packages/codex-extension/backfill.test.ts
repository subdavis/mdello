import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexBackfill } from './backfill.ts';
import { codexHome } from './paths.ts';

test('Codex home resolves the configured directory or the default', () => {
  assert.equal(codexHome({}, '/home/user'), '/home/user/.codex');
  assert.equal(codexHome({ CODEX_HOME: '/custom/codex' }, '/home/user'), '/custom/codex');
});

test('scans nested Codex rollout files within the cutoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-rollouts-'));
  try {
    const dir = join(root, '2026', '10', '08');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'rollout-a.jsonl');
    await writeFile(
      file,
      [
        { type: 'session_meta', payload: { id: 'session-a', cwd: '/board' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '/board/a.md' }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    assert.deepEqual(await codexBackfill.scan(root, 0), [
      { sessionFile: file, sessionId: 'session-a', cardPaths: ['/board/a.md'] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
