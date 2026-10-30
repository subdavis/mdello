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

function recordingContext(): ActionContext & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  return {
    focusTerminal: 'herdr',
    herdrPath: '/usr/local/bin/herdr',
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
  const context = recordingContext();
  assert.equal(await performAction({ action: 'run-agent' }, context), 'invalid');
  assert.equal(await performAction({ action: 'focus' }, context), 'invalid');
  assert.equal(await performAction(null, context), 'invalid');
});

test('refuses to focus when no terminal is configured', async () => {
  const context = recordingContext();
  context.focusTerminal = undefined;
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'claude-session-a' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'herdr_not_configured' });
  assert.deepEqual(context.calls, []);
});

test('reports session_not_found when no herdr pane matches', async () => {
  const context = recordingContext();
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'unknown-session' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'session_not_found' });
});

test('matches a claude session on sessionId without raising its terminal', async () => {
  const context = recordingContext();
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'claude-session-a' },
    context,
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(context.calls, [
    ['/usr/local/bin/herdr', ['agent', 'list']],
    ['/usr/local/bin/herdr', ['agent', 'focus', 'wA:pT']],
    ['/usr/local/bin/herdr', ['tab', 'focus', 'wA:t8']],
  ]);
});

test('matches a pi session on sessionFile rather than sessionId', async () => {
  const context = recordingContext();
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
    focusTerminal: 'herdr',
    herdrPath: '/usr/local/bin/herdr',
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

test('herdr-core focuses the terminal through herdr-app and never asks Herdr', async () => {
  const context = recordingContext();
  context.focusTerminal = 'herdr-core';
  context.herdrAppPath = '/bin/herdr-app';
  const result = await performAction(
    {
      action: 'focus',
      harness: 'pi',
      sessionId: 's',
      sessionFile: '/home/.pi/agent/sessions/pi-session-a.jsonl',
      hcTerminal: 't11',
    },
    context,
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(context.calls, [['/bin/herdr-app', ['do', 'agent.focus', '--terminal', 't11']]]);
});

test('herdr-core cannot focus a session without a known terminal', async () => {
  const context = recordingContext();
  context.focusTerminal = 'herdr-core';
  context.herdrAppPath = '/bin/herdr-app';
  const result = await performAction(
    { action: 'focus', harness: 'claude', sessionId: 'claude-session-a' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'session_not_found' });
  assert.deepEqual(context.calls, []);
});

test('a failing herdr-app is reported, not retried through Herdr', async () => {
  const calls: string[] = [];
  const context: ActionContext = {
    focusTerminal: 'herdr-core',
    herdrPath: '/usr/local/bin/herdr',
    herdrAppPath: '/bin/herdr-app',
    run: async (command) => {
      calls.push(command);
      throw new Error('{ "error": "unknown terminal" }');
    },
  };
  const result = await performAction(
    { action: 'focus', harness: 'pi', sessionId: 's', hcTerminal: 't11' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'herdr_command_failed' });
  assert.deepEqual(calls, ['/bin/herdr-app']);
});

test('herdr focuses through Herdr even when a terminal is known', async () => {
  const context = recordingContext();
  context.herdrAppPath = '/bin/herdr-app';
  const result = await performAction(
    { action: 'focus', harness: 'pi', sessionId: 'unknown-session', hcTerminal: 't15' },
    context,
  );
  assert.deepEqual(result, { ok: false, error: 'session_not_found' });
  assert.equal(
    context.calls.some(([command]) => command === '/bin/herdr-app'),
    false,
  );
});
