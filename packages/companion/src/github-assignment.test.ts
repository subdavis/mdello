import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFile } from '@mdello/common/frontmatter';
import {
  type CommandRunner,
  discoverGitHubAssignments,
  parseGitHubAssignmentConfig,
  syncGitHubAssignments,
} from './github-assignment.ts';

const config = {
  schedule: '0 * * * *',
  organizations: ['SonarSource', 'octo-org'],
  boardUuid: 'board-a',
};

function result(items: unknown[]): { stdout: string } {
  return { stdout: JSON.stringify(items) };
}

test('parses organization arrays and allows an empty array', () => {
  assert.deepEqual(parseGitHubAssignmentConfig(config), config);
  assert.deepEqual(parseGitHubAssignmentConfig({ ...config, organizations: [] }), {
    ...config,
    organizations: [],
  });
  assert.equal(parseGitHubAssignmentConfig(undefined), undefined);
  assert.throws(
    () => parseGitHubAssignmentConfig({ ...config, organizations: ['SonarSource', ''] }),
    /organizations must be an array/,
  );
});

test('queries assigned issues, assigned PRs, and direct review requests with owner filters', async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push(args);
    if (args.includes('user-review-requested:@me')) {
      return result([
        {
          url: 'https://github.com/SonarSource/webapp/pull/2',
          title: 'Review me',
          repository: { nameWithOwner: 'SonarSource/webapp' },
          labels: [{ name: 'frontend' }],
        },
      ]);
    }
    if (args[1] === 'prs') {
      return result([{ url: 'https://github.com/SonarSource/webapp/pull/2', title: 'Review me' }]);
    }
    return result([{ url: 'https://github.com/SonarSource/webapp/issues/1', title: 'Fix me' }]);
  };

  const items = await discoverGitHubAssignments(config, run);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 4)),
    [
      ['search', 'issues', '--assignee', '@me'],
      ['search', 'prs', '--assignee', '@me'],
      ['search', 'prs', 'user-review-requested:@me', '--state'],
    ],
  );
  for (const args of calls) {
    assert.deepEqual(
      args.filter((_arg, index) => args[index - 1] === '--owner'),
      ['SonarSource', 'octo-org'],
    );
    assert.ok(args.includes('--limit'));
  }
  assert.deepEqual(
    items.map(({ url, kind }) => ({ url, kind })),
    [
      { url: 'https://github.com/SonarSource/webapp/issues/1', kind: 'assigned' },
      { url: 'https://github.com/SonarSource/webapp/pull/2', kind: 'review-requested' },
    ],
  );
  assert.equal(items[1].repository, 'SonarSource/webapp');
  assert.deepEqual(items[1].labels, ['frontend']);
});

test('omits owner filters when organizations is empty', async () => {
  const calls: string[][] = [];
  await discoverGitHubAssignments({ organizations: [] }, async (_command, args) => {
    calls.push(args);
    return result([]);
  });
  assert.equal(
    calls.some((args) => args.includes('--owner')),
    false,
  );
});

test('creates cards only for URLs absent from active card files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-github-assignment-'));
  try {
    await mkdir(join(root, 'archive'), { recursive: true });
    await writeFile(
      join(root, 'existing.md'),
      'Already tracks https://github.com/SonarSource/webapp/issues/1.',
    );
    await writeFile(
      join(root, 'archive', 'archived.md'),
      'Tracks https://github.com/SonarSource/webapp/issues/2',
    );
    await writeFile(join(root, 'review-requested-new-card.md'), 'filename collision');

    const run: CommandRunner = async (_command, args) => {
      if (args.includes('user-review-requested:@me')) {
        return result([
          {
            url: 'https://github.com/SonarSource/webapp/pull/3',
            title: 'New card',
            number: 3,
            author: { login: 'octocat' },
            repository: { nameWithOwner: 'SonarSource/webapp' },
            state: 'open',
            updatedAt: '2026-09-18T10:00:00Z',
            labels: [{ name: 'sca' }],
            body: 'Please review this change.',
          },
        ]);
      }
      if (args[1] === 'prs') return result([]);
      return result([
        { url: 'https://github.com/SonarSource/webapp/issues/1', title: 'Existing', labels: [] },
        { url: 'https://github.com/SonarSource/webapp/issues/2', title: 'Archived', labels: [] },
      ]);
    };

    const created = await syncGitHubAssignments({
      config,
      boardPath: root,
      run,
      now: () => new Date('2026-09-18T12:00:00Z'),
      uuid: () => 'generated-uuid',
    });

    assert.deepEqual(
      created.map((path) => path.slice(root.length + 1)),
      ['issue-assigned-archived.md', 'review-requested-new-card-1.md'],
    );
    const review = parseFile(await readFile(created[1], 'utf8'));
    assert.deepEqual(review.data, {
      uuid: 'generated-uuid',
      title: 'Review Requested: New card',
      column: 'Triage',
      tags: [],
      created: '2026-09-18T12:00:00.000Z',
    });
    assert.match(review.body, /^https:\/\/github\.com\/SonarSource\/webapp\/pull\/3/m);
    assert.match(review.body, /Repository: SonarSource\/webapp/);
    assert.match(review.body, /Please review this change\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writes no cards when a gh search fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mdello-github-assignment-'));
  try {
    const run: CommandRunner = async (_command, args) => {
      if (args.includes('user-review-requested:@me')) throw new Error('gh failed');
      return result([{ url: 'https://github.com/org/repo/issues/1', title: 'Found' }]);
    };
    await assert.rejects(syncGitHubAssignments({ config, boardPath: root, run }), /gh failed/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
