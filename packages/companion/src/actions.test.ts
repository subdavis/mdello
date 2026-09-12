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
      },
      {
        agent: 'pi',
        agent_session: { kind: 'path', value: '/home/.pi/agent/sessions/pi-session-a.jsonl' },
        pane_id: 'wA:p14',
      },
    ],
  },
});

function recordingContext(bundleId?: string): ActionContext & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  return {
    herdrBundleId: bundleId,
    calls,
    run: async (command, args) => {
      calls.push([command, args]);
      if (command === 'herdr' && args[0] === 'agent' && args[1] === 'list') {
        return { stdout: AGENT_LIST };
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
    ['herdr', ['agent', 'list']],
    ['herdr', ['agent', 'focus', 'wA:pT']],
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
  assert.deepEqual(context.calls[1], ['herdr', ['agent', 'focus', 'wA:p14']]);
});

test('reports herdr_command_failed when the herdr CLI errors', async () => {
  const context: ActionContext = {
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
