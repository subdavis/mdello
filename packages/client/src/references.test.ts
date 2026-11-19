import assert from 'node:assert/strict';
import test from 'node:test';
import { findReferenceLinks } from './referenceLinks.ts';

test('links into the same PR or ticket collapse to one canonical reference', () => {
  const body = `
https://github.com/o/repo/pull/8783
https://github.com/o/repo/pull/8783#discussion_r1
https://github.com/o/repo/pull/8783/files
https://sonarsource.atlassian.net/browse/SCA-1?focusedCommentId=2
https://sonarsource.atlassian.net/browse/SCA-1
`;
  assert.deepEqual(
    findReferenceLinks(body).map(({ kind, label, url }) => ({ kind, label, url })),
    [
      { kind: 'git', label: 'repo#8783', url: 'https://github.com/o/repo/pull/8783' },
      { kind: 'jira', label: 'SCA-1', url: 'https://sonarsource.atlassian.net/browse/SCA-1' },
    ],
  );
});
