import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompanionClient } from './index.ts';
import { createCompanionHooks } from './index.ts';

interface AssociationBody {
  markdownPath: string;
  harness: string;
  sessionId: string;
  status: string;
}

type SessionMessages = NonNullable<
  Awaited<ReturnType<CompanionClient['session']['messages']>>['data']
>;

function fixture(messages: SessionMessages = []) {
  const requests: AssociationBody[] = [];
  const client: CompanionClient = {
    session: {
      messages: async () => ({ data: messages }),
    },
  };
  const hooks = createCompanionHooks({
    client,
    directory: '/work',
    endpoint: 'http://127.0.0.1:1234/',
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as AssociationBody);
      return new Response('{}');
    },
  });
  return { hooks, requests };
}

test('restores user paths and successful Markdown modifications', async () => {
  const { hooks, requests } = fixture([
    {
      info: { role: 'user' },
      parts: [{ type: 'text', text: 'Work on /boards/first.md' }],
    },
    {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'tool',
          tool: 'edit',
          state: { status: 'completed', input: { filePath: 'second.md' } },
        },
        {
          type: 'tool',
          tool: 'write',
          state: { status: 'error', input: { filePath: '/boards/failed.md' } },
        },
      ],
    },
  ]);

  await hooks.event?.({
    event: { type: 'session.created', properties: { info: { id: 'session-1' } } } as never,
  });

  assert.deepEqual(
    requests.map(({ markdownPath, status }) => [markdownPath, status]),
    [
      ['/boards/first.md', 'idle'],
      ['/work/second.md', 'idle'],
    ],
  );
});

test('discovers prompts and completed edit and write tools once', async () => {
  const { hooks, requests } = fixture();
  const chat = hooks['chat.message'];
  const after = hooks['tool.execute.after'];
  assert.ok(chat && after);

  await chat(
    { sessionID: 'session-1' },
    {
      message: {} as never,
      parts: [{ type: 'text', text: 'Use /boards/card.md twice: /boards/card.md' } as never],
    },
  );
  await after(
    { tool: 'edit', sessionID: 'session-1', callID: 'call-1', args: { filePath: 'other.md' } },
    { title: '', output: '', metadata: {} },
  );
  await after(
    { tool: 'read', sessionID: 'session-1', callID: 'call-2', args: { filePath: 'ignored.md' } },
    { title: '', output: '', metadata: {} },
  );

  assert.deepEqual(requests, [
    {
      markdownPath: '/boards/card.md',
      harness: 'opencode',
      sessionId: 'session-1',
      status: 'running',
    },
    {
      markdownPath: '/work/other.md',
      harness: 'opencode',
      sessionId: 'session-1',
      status: 'running',
    },
  ]);
});

test('maps waiting, running, settled, and closed lifecycle events', async () => {
  const { hooks, requests } = fixture();
  const chat = hooks['chat.message'];
  assert.ok(chat);
  await chat(
    { sessionID: 'session-1' },
    { message: {} as never, parts: [{ type: 'text', text: '/boards/card.md' } as never] },
  );

  for (const event of [
    { type: 'permission.updated', properties: { sessionID: 'session-1' } },
    { type: 'permission.replied', properties: { sessionID: 'session-1' } },
    { type: 'session.idle', properties: { sessionID: 'session-1' } },
    { type: 'session.deleted', properties: { info: { id: 'session-1' } } },
  ]) {
    await hooks.event?.({ event: event as never });
  }

  assert.deepEqual(
    requests.map(({ status }) => status),
    ['running', 'waiting_for_input', 'running', 'ready_for_review', 'closed'],
  );
});

test('never rejects when history or companion requests fail', async () => {
  const hooks = createCompanionHooks({
    directory: '/work',
    client: {
      session: {
        messages: async () => {
          throw new Error('missing session');
        },
      },
    },
    fetch: async () => {
      throw new Error('companion unavailable');
    },
  });
  const chat = hooks['chat.message'];
  assert.ok(chat);

  await assert.doesNotReject(() =>
    chat(
      { sessionID: 'session-1' },
      { message: {} as never, parts: [{ type: 'text', text: '/boards/card.md' } as never] },
    ),
  );
});
