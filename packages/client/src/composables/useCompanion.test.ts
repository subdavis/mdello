import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, type Ref, ref } from 'vue';
import {
  type Association,
  type CompanionConnectionStatus,
  focusSession,
  forgetSession,
  resumeCommand,
  setAutofocus,
  setGitHubLinkEnrichment,
  subscribeUrlEnrichments,
  useAutofocus,
  useCompanionConnectionStatus,
  useGitHubLinkEnrichment,
} from './useCompanion.ts';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const association: Association = {
  boardUuid: 'board-a',
  cardUuid: 'card-a',
  cardPath: '/board/card-a.md',
  harness: 'pi',
  sessionId: 'session with spaces',
  status: 'idle',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('builds an OpenCode resume command', () => {
  assert.equal(
    resumeCommand({ ...association, harness: 'opencode', sessionId: 'ses_123' }),
    'opencode --session ses_123',
  );
});

test('requests session forgetting for one card or all cards', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), method: init?.method ?? '' });
    return new Response(null, { status: 200 });
  };

  try {
    assert.equal(await forgetSession(association, 'card'), true);
    assert.equal(await forgetSession(association, 'all'), true);
    assert.equal(requests[0].url.pathname, '/associations');
    assert.equal(requests[0].url.searchParams.get('harness'), 'pi');
    assert.equal(requests[0].url.searchParams.get('sessionId'), 'session with spaces');
    assert.equal(requests[0].url.searchParams.get('cardUuid'), 'card-a');
    assert.equal(requests[0].method, 'DELETE');
    assert.equal(requests[1].url.searchParams.get('cardUuid'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('persists autofocus through companion settings', async () => {
  const originalFetch = globalThis.fetch;
  let body = '';
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ autofocus: true }), { status: 200 });
  };

  try {
    assert.equal(await setAutofocus(true), true);
    assert.deepEqual(JSON.parse(body), { autofocus: true });
    assert.equal(useAutofocus().value, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('persists GitHub enrichment and subscribes through the generic URL API', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalEventSource = globalThis.EventSource;
  let body = '';
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response('{}', { status: 200 });
  };
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

  try {
    assert.equal(await setGitHubLinkEnrichment(true), true);
    assert.equal(useGitHubLinkEnrichment().value, true);
    assert.deepEqual(JSON.parse(body), { githubLinkEnrichment: true });

    const first = 'https://github.com/owner/repo/issues/12';
    const second = 'https://github.com/owner/repo/pull/13';
    const received: string[][] = [];
    const close = subscribeUrlEnrichments([first, second], (items) =>
      received.push(items.map((item) => item.url)),
    );
    const source = FakeEventSource.instances[0];
    assert.match(source.url, /\/enrichments\?/);
    assert.equal(new URL(source.url).searchParams.getAll('url').length, 2);
    source.emit(
      'enrichments',
      JSON.stringify({
        items: [{ provider: 'github', url: first, number: 12, title: 'Fix bug', status: 'open' }],
      }),
    );
    source.emit(
      'enrichments',
      JSON.stringify({
        items: [
          { provider: 'github', url: second, number: 13, title: 'Add feature', status: 'open' },
        ],
      }),
    );
    assert.deepEqual(received, [[first], [first, second]]);
    close();
    assert.equal(source.closed, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = OriginalEventSource;
  }
});

test('requests session focus without window-raising options', async () => {
  const originalFetch = globalThis.fetch;
  let body = '';
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response(null, { status: 200 });
  };

  try {
    assert.equal(await focusSession(association), true);
    assert.deepEqual(JSON.parse(body), {
      action: 'focus',
      harness: 'pi',
      sessionId: 'session with spaces',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reconnects continuously while enabled and stops when disposed', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  FakeEventSource.instances = [];
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const scope = effectScope();

  try {
    let status: Readonly<Ref<CompanionConnectionStatus>> | undefined;
    scope.run(() => {
      status = useCompanionConnectionStatus(ref(true), ref('board-a'), ref('/boards/first'));
    });

    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(status?.value, 'connecting');
    assert.match(FakeEventSource.instances[0].url, /boardUuid=board-a/);

    FakeEventSource.instances[0].emit('error');
    assert.equal(FakeEventSource.instances[0].closed, true);
    assert.equal(status?.value, 'disconnected');

    context.mock.timers.tick(1_000);
    assert.equal(FakeEventSource.instances.length, 2);
    assert.equal(status?.value, 'connecting');

    FakeEventSource.instances[1].emit('error');
    context.mock.timers.tick(1_000);
    assert.equal(FakeEventSource.instances.length, 3);

    FakeEventSource.instances[2].emit('open');
    assert.equal(status?.value, 'connected');

    scope.stop();
    assert.equal(FakeEventSource.instances[2].closed, true);
    assert.equal(status?.value, 'disabled');
  } finally {
    scope.stop();
    globalThis.EventSource = originalEventSource;
  }
});
