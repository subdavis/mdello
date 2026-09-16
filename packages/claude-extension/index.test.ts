import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_POLICIES,
  claudeAdapter,
  claudeHookSettings,
  claudePluginFiles,
  createClaudeAdapter,
  isCompanionPlugin,
} from './index.ts';

test('maps turn and session lifecycle events to companion statuses', async () => {
  const adapter = createClaudeAdapter();

  assert.equal(
    (await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }))?.status,
    'running',
  );
  assert.equal(
    (await adapter.translate({ hook_event_name: 'StopFailure', session_id: 's1' }))?.status,
    'ready_for_review',
  );
  assert.equal(
    (await adapter.translate({ hook_event_name: 'SessionEnd', session_id: 's1' }))?.status,
    'closed',
  );
  assert.equal(
    await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }),
    undefined,
    'closed wins until a new SessionStart',
  );
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

test('tracks AskUserQuestion from opening through answer or auto-timeout', async () => {
  const adapter = createClaudeAdapter();
  await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });

  const waiting = await adapter.translate({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'question-1',
  });
  assert.equal(waiting?.status, 'waiting_for_input');

  const answered = await adapter.translate({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'question-1',
  });
  assert.equal(answered?.status, 'running');
  assert.deepEqual(answered?.cardPaths, []);
});

test('resolves a delayed anonymous permission notification from a tool result', async () => {
  const adapter = createClaudeAdapter();
  await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });

  assert.equal(
    (
      await adapter.translate({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        session_id: 's1',
      })
    )?.status,
    'waiting_for_input',
  );
  assert.equal(
    (
      await adapter.translate({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_use_id: 'tool-1',
      })
    )?.status,
    'running',
  );
});

test('tracks permission and elicitation blockers until their matching result', async () => {
  const adapter = createClaudeAdapter();
  await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });

  assert.equal(
    (
      await adapter.translate({
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        tool_use_id: 'tool-1',
      })
    )?.status,
    'waiting_for_input',
  );
  assert.equal(
    (
      await adapter.translate({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_use_id: 'tool-1',
      })
    )?.status,
    'running',
  );

  assert.equal(
    (
      await adapter.translate({
        hook_event_name: 'Elicitation',
        session_id: 's1',
        request_id: 'request-1',
      })
    )?.status,
    'waiting_for_input',
  );
  assert.equal(
    (
      await adapter.translate({
        hook_event_name: 'ElicitationResult',
        session_id: 's1',
        request_id: 'request-1',
      })
    )?.status,
    'running',
  );
});

test('does not clear an unrelated blocker in a parallel tool batch', async () => {
  const adapter = createClaudeAdapter();
  await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });
  await adapter.translate({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'question-1',
  });
  await adapter.translate({
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    tool_use_id: 'tool-2',
  });

  // Permission resolved, but question still blocks and status therefore does not need republishing.
  assert.equal(
    await adapter.translate({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_use_id: 'tool-2',
    }),
    undefined,
  );
  assert.equal(
    (
      await adapter.translate({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'question-1',
      })
    )?.status,
    'running',
  );
});

test('ignores a non-card tool result when it causes no lifecycle change', async () => {
  const adapter = createClaudeAdapter();
  await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });

  const event = await adapter.translate({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: '/src/index.ts' },
  });
  assert.equal(event, undefined);
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
  const event = await createClaudeAdapter().translate({
    hook_event_name: 'SessionStart',
    session_id: 's1',
    transcript_path: '/nowhere/missing.jsonl',
  });
  assert.deepEqual(event?.cardPaths, []);
});

test('preserves running state across compaction', async () => {
  const adapter = createClaudeAdapter();
  await adapter.translate({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });

  const compact = await adapter.translate({
    hook_event_name: 'SessionStart',
    session_id: 's1',
    source: 'compact',
  });
  assert.equal(compact?.status, 'running');

  assert.equal(
    await createClaudeAdapter().translate({
      hook_event_name: 'SessionStart',
      session_id: 'unknown',
      source: 'compact',
    }),
    undefined,
  );
});

test('classifies every official hook and configures every lifecycle hook', () => {
  const byName = (left: string, right: string) => left.localeCompare(right);
  assert.deepEqual(
    Object.keys(CLAUDE_HOOK_POLICIES).sort(byName),
    [...CLAUDE_HOOK_EVENTS].sort(byName),
  );

  const expectedSubscriptions = CLAUDE_HOOK_EVENTS.filter(
    (event) => CLAUDE_HOOK_POLICIES[event].kind === 'lifecycle',
  ).sort(byName);
  assert.deepEqual(
    Object.keys(claudeHookSettings('http://127.0.0.1:31337')).sort(byName),
    expectedSubscriptions,
  );
});

test('keeps per-turn events off the process spawn path', () => {
  const settings = claudeHookSettings('http://127.0.0.1:31337/');
  const types = Object.fromEntries(
    Object.entries(settings).map(([event, entries]) => [event, entries[0]?.hooks[0]?.type]),
  );

  assert.deepEqual(types, {
    UserPromptSubmit: 'http',
    PreToolUse: 'http',
    PermissionRequest: 'http',
    PermissionDenied: 'http',
    PostToolUse: 'http',
    PostToolUseFailure: 'http',
    Elicitation: 'http',
    ElicitationResult: 'http',
    Notification: 'http',
    Stop: 'http',
    StopFailure: 'http',
    SessionStart: 'command',
    SessionEnd: 'command',
  });
  assert.equal(settings.Stop?.[0]?.hooks[0]?.url, 'http://127.0.0.1:31337/hooks/claude');
  for (const entries of Object.values(settings)) {
    assert.ok((entries[0]?.hooks[0]?.timeout ?? 0) > 0, 'every hook needs an explicit timeout');
  }
});

test('subscribes to question starts and all tool results', () => {
  const settings = claudeHookSettings('http://127.0.0.1:31337');

  assert.equal(settings.PreToolUse?.[0]?.matcher, 'AskUserQuestion');
  assert.equal(settings.PostToolUse?.[0]?.matcher, undefined);
  assert.equal(settings.PostToolUseFailure?.[0]?.matcher, undefined);
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
  assert.deepEqual(
    Object.keys(files).sort((left, right) => left.localeCompare(right)),
    ['.claude-plugin/plugin.json', 'hooks/hooks.json'],
  );

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
