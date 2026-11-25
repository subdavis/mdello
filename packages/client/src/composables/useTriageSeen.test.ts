import assert from 'node:assert/strict';
import test from 'node:test';
import { nextTick } from 'vue';

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

const { acknowledgeTriage, isTriageUnseen, pruneTriageSeen } = await import('./useTriageSeen.ts');

test('Triage cards are unseen until acknowledged, and again after leaving Triage', async () => {
  const card = { id: 'a', column: 'Triage' };
  assert.equal(isTriageUnseen(card), true);
  assert.equal(isTriageUnseen({ id: 'b', column: 'Todo' }), false);

  acknowledgeTriage('a');
  assert.equal(isTriageUnseen(card), false);
  await nextTick();
  assert.deepEqual(JSON.parse(store.get('mdello:triage-seen') ?? '[]'), ['a']);

  pruneTriageSeen([card]);
  assert.equal(isTriageUnseen(card), false, 'still in Triage keeps it seen');

  pruneTriageSeen([{ id: 'a', column: 'Doing' }]);
  assert.equal(isTriageUnseen(card), true, 'back in Triage notifies again');
});
