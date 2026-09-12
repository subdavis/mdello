import assert from 'node:assert/strict';
import test from 'node:test';
import { focusEditorAtLine } from './editorFocus.ts';

test('sets caret before focusing without browser scrolling and scrolls clicked line into view', () => {
  const calls: string[] = [];
  const scroller = {
    clientHeight: 300,
    scrollTop: 500,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  const stack = {
    closest: () => scroller,
    getBoundingClientRect: () => ({ top: -100 }),
  };
  const area = {
    focus: (options: FocusOptions) => calls.push(`focus:${String(options.preventScroll)}`),
    setSelectionRange: (start: number, end: number) => calls.push(`selection:${start}:${end}`),
  };
  const originalGetComputedStyle = globalThis.getComputedStyle;
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({ lineHeight: '20px' }),
  });

  try {
    focusEditorAtLine(
      area as unknown as HTMLTextAreaElement,
      stack as unknown as HTMLElement,
      'first\nsecond\nthird',
      2,
    );
  } finally {
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: originalGetComputedStyle,
    });
  }

  assert.deepEqual(calls, ['selection:13:13', 'focus:true']);
  assert.equal(scroller.scrollTop, 240);
});
