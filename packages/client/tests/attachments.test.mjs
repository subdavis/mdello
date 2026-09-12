import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFile, serializeFile } from '@mdello/common/frontmatter';

const attachments = [
  {
    file: '1234-screenshot.png',
    name: 'screenshot.png',
    type: 'image/png',
  },
  {
    file: '5678-debug.log',
    name: 'debug.log',
    type: 'text/plain',
  },
];

test('attachment metadata survives a frontmatter round trip', () => {
  const parsed = parseFile(serializeFile({ title: 'Card', attachments }, 'Body'));

  assert.deepEqual(parsed.data.attachments, attachments);
  assert.equal(parsed.body, '\nBody');
});
