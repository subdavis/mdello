import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, type Ref, ref } from 'vue';
import { type CompanionConnectionStatus, useCompanionConnectionStatus } from './useCompanion.ts';

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

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

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
