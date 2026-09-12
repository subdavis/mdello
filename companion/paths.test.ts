import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMarkdownPaths,
  isModificationToolName,
  successfulModificationPaths,
} from './paths.ts';

test('extracts unique absolute markdown paths without a board root', () => {
  assert.deepEqual(
    extractMarkdownPaths(
      "Work on '/first board/one.md', then `/second/two.md`. Revisit /first board/one.md.",
    ),
    ['/first board/one.md', '/second/two.md'],
  );
});

test('ignores relative paths and non-markdown files', () => {
  assert.deepEqual(extractMarkdownPaths('Read notes/card.md and /board/mdello.yml'), []);
});

test('recognizes edit and write as modification tools, but not read', () => {
  assert.equal(isModificationToolName('edit'), true);
  assert.equal(isModificationToolName('write'), true);
  assert.equal(isModificationToolName('read'), false);
});

test('discovers markdown paths from successful edit and write tool calls', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'absolute',
          name: 'write',
          arguments: { path: '/board/first.md', content: 'one' },
        },
        {
          type: 'toolCall',
          id: 'relative',
          name: 'write',
          arguments: { path: 'cards/second.md', content: 'two' },
        },
        {
          type: 'toolCall',
          id: 'failed',
          name: 'write',
          arguments: { path: '/board/failed.md', content: 'no' },
        },
        {
          type: 'toolCall',
          id: 'edit',
          name: 'edit',
          arguments: { path: '/board/edited.md' },
        },
        {
          type: 'toolCall',
          id: 'read',
          name: 'read',
          arguments: { path: '/board/read.md' },
        },
      ],
    },
    { role: 'toolResult', toolName: 'write', toolCallId: 'absolute', isError: false },
    { role: 'toolResult', toolName: 'write', toolCallId: 'relative', isError: false },
    { role: 'toolResult', toolName: 'write', toolCallId: 'failed', isError: true },
    { role: 'toolResult', toolName: 'edit', toolCallId: 'edit', isError: false },
    { role: 'toolResult', toolName: 'read', toolCallId: 'read', isError: false },
  ];

  assert.deepEqual(successfulModificationPaths(messages, '/workspace'), [
    '/board/first.md',
    '/workspace/cards/second.md',
    '/board/edited.md',
  ]);
});
