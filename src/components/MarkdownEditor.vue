<script setup lang="ts">
import { computed, ref } from 'vue';
import hljs from 'highlight.js/lib/core';
import markdown from 'highlight.js/lib/languages/markdown';
// Token colors live in style.css (.editor-layer .hljs-*), GitHub light palette.

// The stock markdown grammar only knows [text](url); add bare URLs and <autolinks>,
// the way VS Code highlights them. Unshifted so it beats the html-tag rule on <autolinks>;
// [text](url) still wins because its match starts earlier, at the '['.
hljs.registerLanguage('markdown', (instance) => {
  const language = markdown(instance);
  language.contains?.unshift({
    className: 'link',
    relevance: 0,
    variants: [{ begin: /<[a-z][a-z0-9+.-]*:\/\/[^\s>]+>/i }, { begin: /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]]+/i }],
  });
  return language;
});

const model = defineModel<string>({ required: true });
const area = ref<HTMLTextAreaElement | null>(null);
const stack = ref<HTMLDivElement | null>(null);

// Trailing newline keeps the highlight layer as tall as the textarea while typing.
const highlighted = computed(() => hljs.highlight(`${model.value}\n`, { language: 'markdown' }).value);

const INDENT = '  '; // matches tab-size: 2 on .editor-layer

/** Leading list marker: indent, bullet or number, gap, optional task box. */
const ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

/** execCommand keeps the browser's native undo stack; setRangeText is the fallback. */
function insert(text: string): void {
  const el = area.value;
  if (!el) return;
  el.focus();
  if (text && document.execCommand('insertText', false, text)) return;

  const { selectionStart: start, selectionEnd: end } = el;
  el.setRangeText(text, start, end, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Start of the line holding `from`, end of the line holding `to`. */
function lineBounds(value: string, from: number, to: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', from - 1) + 1;
  const end = value.indexOf('\n', to);
  return { start, end: end === -1 ? value.length : end };
}

function replaceRange(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  selectionStart = start + text.length,
  selectionEnd = selectionStart,
): void {
  el.setSelectionRange(start, end);
  insert(text);
  el.setSelectionRange(selectionStart, selectionEnd);
}

/** Continues the current list marker; returns false so plain Enter falls through. */
function continueList(el: HTMLTextAreaElement): boolean {
  const { value, selectionStart: caret, selectionEnd } = el;
  const { start, end } = lineBounds(value, caret, selectionEnd);
  const match = ITEM.exec(value.slice(start, end));
  if (!match) return false;

  const [prefix, indent, bullet, number, delimiter, gap, task] = match;

  // Enter on an item with no content ends the list instead of adding another blank one.
  if (!value.slice(start + prefix.length, end).trim()) {
    replaceRange(el, start, end, '\n');
    return true;
  }

  const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
  replaceRange(el, caret, selectionEnd, `\n${indent}${marker}${gap}${task ? '[ ] ' : ''}`);
  return true;
}

/** Tab indents; a multi-line selection is shifted line by line and stays selected. */
function indent(el: HTMLTextAreaElement, outdent: boolean): void {
  const { value, selectionStart: from, selectionEnd: to } = el;

  if (value.slice(from, to).includes('\n')) {
    const { start, end } = lineBounds(value, from, to);
    const text = value
      .slice(start, end)
      .split('\n')
      .map((line) => (outdent ? line.replace(/^ {1,2}/, '') : INDENT + line))
      .join('\n');
    replaceRange(el, start, end, text, start, start + text.length);
    return;
  }

  if (!outdent) {
    replaceRange(el, from, to, INDENT);
    return;
  }

  const { start } = lineBounds(value, from, from);
  const removed = /^ {1,2}/.exec(value.slice(start))?.[0];
  if (!removed) return;
  replaceRange(el, start, start + removed.length, '', Math.max(start, from - removed.length));
}

/** Wraps the selection and keeps it selected, so a second press is predictable. */
function wrap(el: HTMLTextAreaElement, marks: string): void {
  const { value, selectionStart: from, selectionEnd: to } = el;
  const inner = value.slice(from, to);
  const caret = from + marks.length;
  replaceRange(el, from, to, `${marks}${inner}${marks}`, caret, caret + inner.length);
}

function onKeydown(event: KeyboardEvent): void {
  const el = area.value;
  if (!el || event.isComposing) return;
  const command = event.metaKey || event.ctrlKey;

  if (command && !event.altKey && (event.key === 'b' || event.key === 'i')) {
    event.preventDefault();
    wrap(el, event.key === 'b' ? '**' : '*');
  } else if (event.key === 'Tab') {
    event.preventDefault();
    indent(el, event.shiftKey);
  } else if (event.key === 'Enter' && !command && !event.shiftKey && !event.altKey) {
    // Text is already inserted; preventDefault stops the browser adding a second newline.
    if (continueList(el)) event.preventDefault();
  }
}

/** Focus the textarea, putting the caret at the start of `line` and scrolling it into view. */
function focus(line = 0): void {
  const el = area.value;
  if (!el) return;
  const offset = model.value.split('\n').slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
  el.focus();
  el.setSelectionRange(offset, offset);
  if (!stack.value) return;
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 1;
  stack.value.scrollTop = Math.max(0, line * lineHeight - stack.value.clientHeight / 3);
}

defineExpose({ focus });
</script>

<template>
  <!-- One scroller (.editor-stack) holds both layers, so they cannot drift apart mid-scroll. -->
  <div ref="stack" class="editor-stack">
    <div class="editor-inner">
      <!-- eslint-disable-next-line vue/no-v-html -- output of highlight.js, input is escaped -->
      <pre class="editor-layer hljs" aria-hidden="true"><code v-html="highlighted" /></pre>
      <textarea
        ref="area"
        v-model="model"
        class="editor-layer editor-input"
        aria-label="Card markdown"
        spellcheck="false"
        @keydown="onKeydown"
      />
    </div>
  </div>
</template>
