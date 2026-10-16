import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexAdapter, codexHookSettings, isManagedHook } from './index.ts';
import { modificationPaths, scanTranscript } from './transcript.ts';

const card = '/board/implement.md';
const base = { session_id: 'session-a', transcript_path: '/session.jsonl', cwd: '/board' };

test('Codex hooks cover lifecycle with bounded timeouts and inert stdout', () => {
  const hooks = codexHookSettings('http://127.0.0.1:51618');
  assert.deepEqual(Object.keys(hooks), [
    'SessionStart',
    'UserPromptSubmit',
    'PostToolUse',
    'PermissionRequest',
    'Stop',
    'Interrupt',
    'SessionEnd',
  ]);
  for (const [event, groups] of Object.entries(hooks)) {
    assert.equal(groups.length, 1);
    const group = groups[0] as { hooks: { command: string; timeout: number }[] };
    assert.ok(isManagedHook(group.hooks[0]));
    assert.match(group.hooks[0].command, /--data-binary @-/);
    assert.ok(group.hooks[0].timeout <= (event === 'Interrupt' || event === 'SessionEnd' ? 3 : 5));
  }
  assert.throws(() => codexHookSettings('https://example.com'));
});

test('Codex adapter discovers prompts, edits and restores transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-codex-'));
  try {
    const path = join(root, 'session.jsonl');
    await writeFile(
      path,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: card }] },
      }),
    );
    assert.deepEqual(
      await codexAdapter.translate({
        ...base,
        transcript_path: path,
        hook_event_name: 'SessionStart',
      }),
      {
        sessionId: 'session-a',
        sessionFile: path,
        status: 'idle',
        cardPaths: [card],
      },
    );
    assert.equal(
      await codexAdapter.translate({ ...base, hook_event_name: 'SessionStart', source: 'compact' }),
      undefined,
    );
    assert.deepEqual(
      (
        await codexAdapter.translate({
          ...base,
          hook_event_name: 'UserPromptSubmit',
          prompt: `Work on ${card}`,
        })
      )?.cardPaths,
      [card],
    );
    assert.deepEqual(
      (
        await codexAdapter.translate({
          ...base,
          hook_event_name: 'PostToolUse',
          tool_name: 'apply_patch',
          tool_input: { command: '*** Update File: implement.md' },
          tool_response: { success: false },
        })
      )?.cardPaths,
      [],
    );
    assert.deepEqual(
      (
        await codexAdapter.translate({
          ...base,
          hook_event_name: 'PostToolUse',
          tool_name: 'apply_patch',
          tool_input: { command: '*** Update File: implement.md\n*** Add File: other.md' },
          tool_response: 'Success. Updated the following files:\nM implement.md\nA other.md',
        })
      )?.cardPaths,
      [card, '/board/other.md'],
    );
    assert.deepEqual(
      (
        await codexAdapter.translate({
          ...base,
          hook_event_name: 'PostToolUse',
          tool_name: 'functions.edit',
          tool_input: { path: card },
          tool_response: { success: true },
        })
      )?.cardPaths,
      [card],
    );
    for (const [event, status] of [
      ['PermissionRequest', 'waiting_for_input'],
      ['Stop', 'ready_for_review'],
      ['Interrupt', 'ready_for_review'],
      ['SessionEnd', 'closed'],
    ] as const) {
      assert.equal(
        (await codexAdapter.translate({ ...base, hook_event_name: event }))?.status,
        status,
      );
    }
    assert.equal(await codexAdapter.translate({ ...base, hook_event_name: 'Unknown' }), undefined);
    assert.equal(await codexAdapter.translate({ hook_event_name: 'Stop' }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit discovery rejects failures, unknown results and serialized errors', async () => {
  const input = { command: '*** Update File: implement.md' };
  for (const output of [
    'apply_patch verification failed: Failed to find expected lines',
    JSON.stringify({ isError: true, content: [{ type: 'text', text: 'error' }] }),
    { output: 'apply_patch verification failed: missing file', exit_code: 1 },
    undefined,
    'unrecognized output',
  ]) {
    const event = await codexAdapter.translate({
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_input: input,
      tool_response: output,
    });
    assert.deepEqual(event?.cardPaths, []);
  }
  assert.deepEqual(
    modificationPaths('apply_patch', input, JSON.stringify({ success: true }), '/board'),
    [card],
  );
});

test('patch moves discover the destination, including moves into or out of Markdown', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: old.md',
    '*** Move to: new.md',
    '@@',
    '-old',
    '+new',
    '*** Update File: source.txt',
    '*** Move to: card.md',
    '@@',
    '-old',
    '+new',
    '*** Update File: removed.md',
    '*** Move to: removed.txt',
    '@@',
    '-old',
    '+new',
    '*** Add File: added.md',
    '+text',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(
    modificationPaths('apply_patch', { command: patch }, { success: true }, '/board'),
    ['/board/new.md', '/board/card.md', '/board/added.md'],
  );
});

test('rollout recovery checks actual outputs and marks code mode incomplete', () => {
  const patch = '*** Update File: old.md\n*** Move to: new.md';
  const entries = [
    { type: 'session_meta', payload: { id: 'session-a', cwd: '/board' } },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'success',
        input: patch,
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'success',
        output: 'Success. Updated the following files:\nM new.md',
      },
    },
    ...['apply_patch verification failed: missing file', JSON.stringify({ isError: true })].flatMap(
      (output, index) => [
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'apply_patch',
            call_id: `failed-${index}`,
            input: `*** Update File: failed-${index}.md`,
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: `failed-${index}`,
            output,
          },
        },
      ],
    ),
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'code',
        input: 'text(await tools.apply_patch(patch));',
      },
    },
  ];
  assert.deepEqual(scanTranscript(entries.map((entry) => JSON.stringify(entry)).join('\n')), {
    sessionId: 'session-a',
    cardPaths: ['/board/new.md'],
    incomplete: true,
  });
});

test('backfill accepts only user text and successful explicit modification calls', () => {
  const lines = [
    {
      type: 'session_meta',
      payload: { id: 'session-a', cwd: '/board' },
      timestamp: '2026-10-01T00:00:00Z',
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: card }] },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '/board/ignore.md' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'write',
        call_id: 'a',
        arguments: '{"path":"other.md"}',
      },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'a', output: 'ok' },
      timestamp: '2026-10-02T00:00:00Z',
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'edit',
        call_id: 'b',
        arguments: '{"path":"failed.md"}',
      },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'b', output: { is_error: true } },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'read',
        call_id: 'c',
        arguments: '{"path":"read.md"}',
      },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c', output: 'ok' },
    },
  ];
  const scan = scanTranscript(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n{corrupt`);
  assert.deepEqual(scan, {
    sessionId: 'session-a',
    cardPaths: [card, '/board/other.md'],
    updatedAt: '2026-10-02T00:00:00Z',
  });
});
