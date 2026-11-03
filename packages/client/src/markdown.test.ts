import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownOutline, renderMarkdown, setTaskChecked } from './markdown.ts';

test('builds a nested outline with all heading levels and matching preview lines', () => {
  const source = '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n## Sibling\n# Next';
  const outline = markdownOutline(source);
  assert.equal(outline.length, 2);
  assert.equal(outline[0].children.length, 2);
  assert.equal(outline[0].children[1].text, 'Sibling');
  assert.equal(outline[1].text, 'Next');

  let heading = outline[0];
  const html = renderMarkdown(source);
  for (let level = 1; level <= 6; level += 1) {
    assert.equal(heading.level, level);
    assert.equal(heading.line, level - 1);
    assert.match(html, new RegExp(`<h${level} data-line="${heading.line}">`));
    heading = heading.children[0];
  }
});

test('handles skipped levels, repeated titles, Setext headings, and inline formatting', () => {
  const outline = markdownOutline(
    'Title\n=====\n\n#### **Deep** [link](https://example.com) `code` ![image](x.png)\n\n## Title\n\nSubtitle\n--------',
  );
  assert.deepEqual(outline, [
    {
      text: 'Title',
      level: 1,
      line: 0,
      children: [
        { text: 'Deep link code image', level: 4, line: 3, children: [] },
        { text: 'Title', level: 2, line: 5, children: [] },
        { text: 'Subtitle', level: 2, line: 7, children: [] },
      ],
    },
  ]);
});

test('excludes heading-like text in code and includes headings inside blockquotes', () => {
  const source = '```md\n# Fenced\n```\n\n    # Indented code\n\n> ### Quoted\n\nParagraph # text';
  assert.deepEqual(markdownOutline(source), [{ text: 'Quoted', level: 3, line: 6, children: [] }]);
  assert.deepEqual(markdownOutline('No headings here'), []);
  assert.deepEqual(markdownOutline(''), []);
});

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

test('renders svg fences as a sandboxed image with collapsible source', () => {
  const html = renderMarkdown(
    '```svg\n<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>\n```',
  );
  assert.match(
    html,
    /<div class="svg-block" data-line="0"><img src="data:image\/svg\+xml;charset=utf-8,/,
  );
  assert.match(html, /xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22/);
  assert.match(html, /<details><summary>SVG source<\/summary><pre><code>&lt;svg/);
  assert.doesNotMatch(html, /<script/);
});

test('treats xml fences holding a lone svg as svg, leaves others as code', () => {
  assert.match(renderMarkdown('```xml\n<svg></svg>\n```'), /class="svg-block"/);
  assert.doesNotMatch(renderMarkdown('```xml\n<a/>\n```'), /svg-block/);
  assert.doesNotMatch(renderMarkdown('```svg\n\n```'), /svg-block/);
});
