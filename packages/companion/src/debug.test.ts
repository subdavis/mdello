import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebugLogger } from './debug.ts';

test('logs structured companion activity only when DEBUG=1', () => {
  const messages: string[] = [];
  createDebugLogger({ DEBUG: '0' }, (message) => messages.push(message))('hidden');
  createDebugLogger({ DEBUG: '1' }, (message) => messages.push(message))('request received', {
    method: 'GET',
    path: '/events?boardUuid=board-a',
  });

  assert.deepEqual(messages, [
    '[mdello-companion] request received {"method":"GET","path":"/events?boardUuid=board-a"}',
  ]);
});
