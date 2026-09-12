import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isModificationToolName,
  modificationPath,
  parseTranscript,
  transcriptPaths,
} from './transcript.ts';

test('recognizes Claude file modification tools, but not reads', () => {
  assert.equal(isModificationToolName('Edit'), true);
  assert.equal(isModificationToolName('MultiEdit'), true);
  assert.equal(isModificationToolName('Write'), true);
  assert.equal(isModificationToolName('Read'), false);
  assert.equal(isModificationToolName('edit'), false);
});

test('resolves modification paths against the session directory', () => {
  assert.equal(modificationPath('Write', { file_path: '/board/one.md' }), '/board/one.md');
  assert.equal(
    modificationPath('Edit', { file_path: 'cards/two.md' }, '/workspace'),
    '/workspace/cards/two.md',
  );
  assert.equal(modificationPath('Edit', { file_path: 'cards/two.md' }), undefined);
  assert.equal(modificationPath('Read', { file_path: '/board/one.md' }), undefined);
  assert.equal(modificationPath('Write', { file_path: '/board/notes.txt' }), undefined);
  assert.equal(modificationPath('Write', { notebook_path: '/board/one.md' }), undefined);
});

test('skips damaged transcript lines', () => {
  const entries = parseTranscript('{"type":"user"}\n\nnot json\n{"type":"assistant"}\n');
  assert.deepEqual(entries, [{ type: 'user' }, { type: 'assistant' }]);
});

test('discovers card paths from user text and successful modifications', () => {
  const entries = [
    {
      type: 'user',
      cwd: '/workspace',
      message: { role: 'user', content: 'Start /board/mentioned.md please' },
    },
    {
      type: 'user',
      cwd: '/workspace',
      message: { role: 'user', content: [{ type: 'text', text: 'Also /board/blocks.md' }] },
    },
    {
      type: 'assistant',
      cwd: '/workspace',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'ok', name: 'Write', input: { file_path: '/board/written.md' } },
          {
            type: 'tool_use',
            id: 'relative',
            name: 'Edit',
            input: { file_path: 'cards/relative.md' },
          },
          {
            type: 'tool_use',
            id: 'failed',
            name: 'Edit',
            input: { file_path: '/board/failed.md' },
          },
          { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/board/read.md' } },
          { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'user',
      cwd: '/workspace',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'ok', content: 'done', is_error: false },
          { type: 'tool_result', tool_use_id: 'relative', content: 'done', is_error: false },
          { type: 'tool_result', tool_use_id: 'failed', content: 'boom', is_error: true },
          { type: 'tool_result', tool_use_id: 'read', content: 'text', is_error: false },
        ],
      },
    },
  ];

  assert.deepEqual(transcriptPaths(entries), [
    '/board/mentioned.md',
    '/board/blocks.md',
    '/board/written.md',
    '/workspace/cards/relative.md',
  ]);
});

test('ignores a modification whose result never arrived', () => {
  const entries = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'pending', name: 'Write', input: { file_path: '/board/a.md' } },
        ],
      },
    },
  ];

  assert.deepEqual(transcriptPaths(entries), []);
});

test('prefers each entry cwd over the fallback directory', () => {
  const entries = [
    {
      type: 'assistant',
      cwd: '/moved',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: 'card.md' } }],
      },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
    },
  ];

  assert.deepEqual(transcriptPaths(entries, '/start'), ['/moved/card.md']);
});

test('tolerates entries without messages', () => {
  assert.deepEqual(transcriptPaths([null, 'x', { type: 'summary' }, { message: 7 }]), []);
});
