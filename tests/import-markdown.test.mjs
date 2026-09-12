import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdownImport } from '../src/importMarkdown.ts';

test('uses first ATX heading as title and removes it from body', () => {
  assert.deepEqual(parseMarkdownImport('notes.md', '### Imported card ###\n\nBody text\n'), {
    title: 'Imported card',
    body: '\nBody text\n',
  });
});

test('supports each Markdown ATX heading level', () => {
  for (let level = 1; level <= 6; level += 1) {
    assert.deepEqual(parseMarkdownImport('notes.md', `${'#'.repeat(level)} Heading\nBody`), {
      title: 'Heading',
      body: 'Body',
    });
  }
});

test('uses filename and keeps full document when first line is not a heading', () => {
  const text = 'Intro paragraph\n\n# Later heading';
  assert.deepEqual(parseMarkdownImport('release-notes.MD', text), {
    title: 'release-notes',
    body: text,
  });
});

test('handles a heading-only document', () => {
  assert.deepEqual(parseMarkdownImport('notes.md', '# Title'), {
    title: 'Title',
    body: '',
  });
});
