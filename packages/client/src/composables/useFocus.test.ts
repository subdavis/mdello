import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

const { setCardFocused, useFocus } = await import('./useFocus.ts');

test('hides only unfocused cards while focus mode is on', () => {
  const focus = useFocus();
  setCardFocused('a', true);

  assert.equal(focus.isHidden('b'), false, 'nothing hidden while mode is off');

  focus.toggleMode();
  assert.equal(focus.isHidden('a'), false);
  assert.equal(focus.isHidden('b'), true);

  focus.toggleCard('a');
  assert.equal(focus.isHidden('a'), true);
});

test('persists mode and focused cards to localStorage', async () => {
  const focus = useFocus();
  setCardFocused('c', true);
  await new Promise((resolve) => setTimeout(resolve));

  assert.equal(store.get('mdello:focus-mode'), 'true');
  assert.deepEqual(JSON.parse(store.get('mdello:focused-cards') ?? '[]').includes('c'), true);
  assert.equal(focus.isFocused('c'), true);
});
