import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown, setTaskChecked } from './markdown.ts';

test('renders interactive task checkboxes for bullet and ordered lists', () => {
  const html = renderMarkdown(
    ['- [ ] dash', '* [x] star', '+ [X] plus', '1. [ ] ordered'].join('\n'),
  );

  assert.match(html, /data-task-line="0" aria-label="Toggle task">dash/);
  assert.match(html, /data-task-line="1" aria-label="Toggle task" checked>star/);
  assert.match(html, /data-task-line="2" aria-label="Toggle task" checked>plus/);
  assert.match(html, /data-task-line="3" aria-label="Toggle task">ordered/);
  assert.equal((html.match(/class="task-list-item"/g) ?? []).length, 4);
});

test('renders nested and blockquoted tasks with their source lines', () => {
  const html = renderMarkdown('- [ ] outer\n  - [x] inner\n\n> * [ ] quoted');

  assert.match(html, /data-task-line="0"/);
  assert.match(html, /data-task-line="1"[^>]* checked/);
  assert.match(html, /data-task-line="3"/);
});

test('does not treat task-like text outside a list or later in a list item as a task', () => {
  const html = renderMarkdown('[ ] paragraph\n\n- ordinary\n\n  [x] later paragraph');

  assert.doesNotMatch(html, /task-list-item-checkbox/);
  assert.match(html, /\[ \] paragraph/);
  assert.match(html, /\[x\] later paragraph/);
});

test('preserves inline markdown following a task marker', () => {
  const html = renderMarkdown('- [ ] **bold** and [link](https://example.com)');

  assert.match(html, /task-list-item-checkbox/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
});

test('sets task state on the requested line only', () => {
  const source = '- [ ] first\n* [x] second\n+ [X] third\n1. [ ] fourth';

  assert.equal(
    setTaskChecked(source, 1, false),
    '- [ ] first\n* [ ] second\n+ [X] third\n1. [ ] fourth',
  );
  assert.equal(
    setTaskChecked(source, 3, true),
    '- [ ] first\n* [x] second\n+ [X] third\n1. [x] fourth',
  );
});

test('preserves indentation, blockquotes, uppercase markers, and CRLF endings', () => {
  const source = '  - [ ] nested\r\n> * [X] quoted\r\nunchanged';

  assert.equal(
    setTaskChecked(setTaskChecked(source, 0, true), 1, false),
    '  - [x] nested\r\n> * [ ] quoted\r\nunchanged',
  );
});

test('leaves source unchanged for invalid lines and non-task text', () => {
  const source = '[ ] paragraph\n- ordinary';

  assert.equal(setTaskChecked(source, -1, true), source);
  assert.equal(setTaskChecked(source, 10, true), source);
  assert.equal(setTaskChecked(source, 0, true), source);
  assert.equal(setTaskChecked(source, 1, true), source);
});
