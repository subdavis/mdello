import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  claudeAdapter,
  claudeHookSettings,
  claudePluginFiles,
  isCompanionPlugin,
} from './index.ts';

test('maps each lifecycle event to a companion status', async () => {
  const events: [string, string][] = [
    ['UserPromptSubmit', 'running'],
    ['PostToolUse', 'running'],
    ['Notification', 'waiting_for_input'],
    ['Stop', 'ready_for_review'],
    ['SessionEnd', 'closed'],
  ];

  for (const [hook_event_name, status] of events) {
    const payload = {
      hook_event_name,
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: '/board/card.md' },
    };
    assert.equal((await claudeAdapter.translate(payload))?.status, status, hook_event_name);
  }
});

test('discovers cards from a prompt and records the transcript as the session file', async () => {
  const event = await claudeAdapter.translate({
    hook_event_name: 'UserPromptSubmit',
    session_id: 's1',
    transcript_path: '/sessions/s1.jsonl',
    prompt: 'work on /board/one.md and /board/two.md',
  });

  assert.deepEqual(event, {
    sessionId: 's1',
    sessionFile: '/sessions/s1.jsonl',
    status: 'running',
    cardPaths: ['/board/one.md', '/board/two.md'],
  });
});

test('discovers a card from a tool call, resolving against the session directory', async () => {
  const event = await claudeAdapter.translate({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    cwd: '/workspace',
    tool_name: 'Edit',
    tool_input: { file_path: 'cards/one.md' },
  });

  assert.deepEqual(event?.cardPaths, ['/workspace/cards/one.md']);
});

test('moves a session back to running when the user answers a question', async () => {
  const event = await claudeAdapter.translate({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_name: 'AskUserQuestion',
  });

  assert.equal(event?.status, 'running');
  assert.deepEqual(event?.cardPaths, []);
});

test('ignores a tool call that cannot touch a card', async () => {
  for (const tool_input of [{ file_path: '/src/index.ts' }, { file_path: 'relative.md' }, {}]) {
    const event = await claudeAdapter.translate({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Edit',
      tool_input,
    });
    assert.equal(event, undefined, JSON.stringify(tool_input));
  }
});

test('ignores payloads with no event, no session, or an unknown event', async () => {
  assert.equal(await claudeAdapter.translate(undefined), undefined);
  assert.equal(await claudeAdapter.translate({ hook_event_name: 'Stop' }), undefined);
  assert.equal(await claudeAdapter.translate({ session_id: 's1' }), undefined);
  assert.equal(
    await claudeAdapter.translate({ hook_event_name: 'PreToolUse', session_id: 's1' }),
    undefined,
  );
});

test('restores cards from the transcript on session start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-adapter-'));
  const transcript = join(root, 'session.jsonl');

  try {
    await writeFile(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          cwd: '/workspace',
          message: { role: 'user', content: 'start /board/from-prompt.md' },
        }),
        JSON.stringify({
          type: 'assistant',
          cwd: '/workspace',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'a', name: 'Write', input: { file_path: '/board/made.md' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
        }),
      ].join('\n'),
    );

    const event = await claudeAdapter.translate({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      transcript_path: transcript,
      source: 'resume',
    });
    assert.equal(event?.status, 'idle');
    assert.deepEqual(event?.cardPaths, ['/board/from-prompt.md', '/board/made.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('treats a missing transcript as an empty session', async () => {
  const event = await claudeAdapter.translate({
    hook_event_name: 'SessionStart',
    session_id: 's1',
    transcript_path: '/nowhere/missing.jsonl',
  });
  assert.deepEqual(event?.cardPaths, []);
});

test('keeps per-turn events off the process spawn path', () => {
  const settings = claudeHookSettings('http://127.0.0.1:31337/');
  const types = Object.fromEntries(
    Object.entries(settings).map(([event, entries]) => [event, entries[0]?.hooks[0]?.type]),
  );

  assert.deepEqual(types, {
    UserPromptSubmit: 'http',
    PostToolUse: 'http',
    Notification: 'http',
    Stop: 'http',
    SessionStart: 'command',
    SessionEnd: 'command',
  });
  assert.equal(settings.Stop?.[0]?.hooks[0]?.url, 'http://127.0.0.1:31337/hooks/claude');
  for (const entries of Object.values(settings)) {
    assert.ok((entries[0]?.hooks[0]?.timeout ?? 0) > 0, 'every hook needs an explicit timeout');
  }
});

test('subscribes to question answers', () => {
  const matcher = claudeHookSettings('http://127.0.0.1:31337').PostToolUse?.[0]?.matcher ?? '';

  assert.ok(matcher.split('|').includes('AskUserQuestion'));
});

test('subscribes only to notifications that block on the human', () => {
  const matcher = claudeHookSettings('http://127.0.0.1:31337').Notification?.[0]?.matcher ?? '';
  const types = matcher.split('|');

  assert.ok(types.includes('permission_prompt'), 'a permission prompt blocks on the human');
  assert.ok(types.includes('agent_needs_input'), 'an asked question blocks on the human');
  // A finished session sitting idle is ready_for_review, not waiting_for_input.
  assert.ok(!types.includes('idle_prompt'), 'idle is not waiting for input');
  assert.ok(matcher, 'an empty matcher would subscribe to every notification type');
});

test('emits a loadable plugin whose hooks carry the companion endpoint', () => {
  const files = claudePluginFiles('http://127.0.0.1:41337');
  assert.deepEqual(Object.keys(files).sort(), ['.claude-plugin/plugin.json', 'hooks/hooks.json']);

  const manifest = JSON.parse(files['.claude-plugin/plugin.json'] ?? '');
  assert.equal(manifest.name, 'mdello-companion');
  assert.ok(manifest.description, 'a plugin listing needs a description');

  const { hooks } = JSON.parse(files['hooks/hooks.json'] ?? '');
  assert.equal(hooks.Stop[0].hooks[0].url, 'http://127.0.0.1:41337/hooks/claude');
  assert.match(hooks.SessionStart[0].hooks[0].command, /41337\/hooks\/claude/);
});

test('marks its own plugin directory so uninstall spares everyone else', () => {
  const manifest = JSON.parse(
    claudePluginFiles('http://127.0.0.1:31337')['.claude-plugin/plugin.json'] ?? '',
  );
  assert.equal(isCompanionPlugin(manifest), true);
  assert.equal(isCompanionPlugin({ name: 'mdello-companion' }), false);
  assert.equal(isCompanionPlugin({ metadata: { managedBy: 'someone-else' } }), false);
  assert.equal(isCompanionPlugin(undefined), false);
});
