import assert from 'node:assert/strict';
import test from 'node:test';
import { type ActionContext, performAction } from './actions.ts';

const AGENT_LIST = JSON.stringify({
  result: {
    agents: [
      {
        agent: 'claude',
        agent_session: { kind: 'id', value: 'claude-session-a' },
        pane_id: 'wA:pT',
        tab_id: 'wA:t8',
        workspace_id: 'wA',
      },
      {
        agent: 'pi',
        agent_session: { kind: 'path', value: '/home/.pi/agent/sessions/pi-session-a.jsonl' },
        pane_id: 'wA:p14',
        tab_id: 'wA:t9',
        workspace_id: 'wA',
      },
    ],
  },
});

function recordingContext(bundleId?: string): ActionContext & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  return {
    herdrPath: '/usr/local/bin/herdr',
    herdrBundleId: bundleId,
    calls,
    run: async (command, args) => {
      calls.push([command, args]);
      if (command === '/usr/local/bin/herdr' && args[1] === 'list') {
        if (args[0] === 'agent') return { stdout: AGENT_LIST };
        if (args[0] === 'tab') {
          return {
            stdout: JSON.stringify({
              result: {
                tabs: [
                  { tab_id: 'wA:t8', label: 'Main' },
                  { tab_id: 'wA:t9', label: 'Background Three' },
                ],
              },
            }),
          };
        }
        if (args[0] === 'workspace') {
          return {
            stdout: JSON.stringify({
              result: { workspaces: [{ workspace_id: 'wA', label: 'Frontend' }] },
            }),
          };
        }
      }
      return { stdout: '' };
    },
  };
}

test('rejects a request that is not a recognized action', async () => {
  const context = recordingContext('com.mitchellh.ghostty');
  assert.equal(await performAction({ action: 'run-agent' }, context), 'invalid');
  assert.equal(await performAction({ action: 'focus' }, context), 'invalid');
  assert.equal(await performAction(null, context), 'invalid');
});

test('refuses to focus when no bundle id is configured', async () => {
  const context = recordingContext();
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'claude-session-a' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'herdr_not_configured' });
  assert.deepEqual(context.calls, []);
});

test('refuses to focus when no herdr path is configured', async () => {
  const context = recordingContext('com.mitchellh.ghostty');
  context.herdrPath = undefined;
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'claude-session-a' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'herdr_not_configured' });
  assert.deepEqual(context.calls, []);
});

test('reports session_not_found when no herdr pane matches', async () => {
  const context = recordingContext('com.mitchellh.ghostty');
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'unknown-session' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'session_not_found' });
});

test('matches a claude session on sessionId and raises the configured bundle', async () => {
  const context = recordingContext('com.mitchellh.ghostty');
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'claude-session-a' },
    context,
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(context.calls, [
    ['/usr/local/bin/herdr', ['agent', 'list']],
    ['/usr/local/bin/herdr', ['agent', 'focus', 'wA:pT']],
    ['/usr/local/bin/herdr', ['tab', 'focus', 'wA:t8']],
    ['open', ['-b', 'com.mitchellh.ghostty']],
  ]);
});

test('matches a pi session on sessionFile rather than sessionId', async () => {
  const context = recordingContext('com.mitchellh.ghostty');
  const result = await performAction(
    {
      action: 'focus',
      harness: 'pi',
      sessionId: 'does-not-match-anything',
      sessionFile: '/home/.pi/agent/sessions/pi-session-a.jsonl',
    },
    context,
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(context.calls.slice(1, 3), [
    ['/usr/local/bin/herdr', ['agent', 'focus', 'wA:p14']],
    ['/usr/local/bin/herdr', ['tab', 'focus', 'wA:t9']],
  ]);
});

test('reports herdr_command_failed when the herdr CLI errors', async () => {
  const context: ActionContext = {
    herdrPath: '/usr/local/bin/herdr',
    herdrBundleId: 'com.mitchellh.ghostty',
    run: async () => {
      throw new Error('herdr: no server running');
    },
  };
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'claude-session-a' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'herdr_command_failed' });
});
