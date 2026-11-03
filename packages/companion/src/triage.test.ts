import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFile } from '@mdello/common/frontmatter';
import { runExtension } from './extensions.ts';
import { fetchReviewRequests } from './github-assignment.ts';
import { fetchAssignedIssues, jiraOrigin } from './jira-assignment.ts';
import { slugify, triageItems } from './triage.ts';

const NOW = () => new Date('2026-11-02T12:00:00.000Z');

const PR = {
  url: 'https://github.com/SonarSource/sonar-sca/pull/2561',
  title: 'SCA-3340 Bound CPU use',
  isDraft: true,
  updatedAt: '2026-11-02T18:49:47Z',
  author: { login: 'someone' },
};

const ISSUE = {
  key: 'COSCA-149',
  fields: {
    summary: '[UX Design] Container table',
    issueType: { name: 'Feature' },
    status: { name: 'Open' },
    priority: { name: 'Normal' },
    reporter: { displayName: 'Caroline' },
    updated: '2026-10-30T18:22:50.534+0100',
  },
};

async function tempBoard(): Promise<string> {
  const board = await mkdtemp(join(tmpdir(), 'mdello-triage-'));
  await mkdir(join(board, 'archive', '2026-10'), { recursive: true });
  return board;
}

test('parses review requests and passes organizations to gh', async () => {
  const calls: string[][] = [];
  const items = await fetchReviewRequests('gh', ['SonarSource'], async (_command, args) => {
    calls.push(args);
    return { stdout: JSON.stringify([PR]) };
  });
  assert.deepEqual(calls[0].slice(-2), ['--owner', 'SonarSource']);
  assert.ok(calls[0].includes('user-review-requested:@me'));
  assert.ok(!calls[0].includes('--review-requested=@me'));
  assert.equal(items[0].title, 'Review: sonar-sca#2561 SCA-3340 Bound CPU use');
  assert.match(items[0].body, /\| Draft \| yes \|/);
  assert.ok(items[0].bound.test('see https://github.com/sonarsource/sonar-sca/pull/2561.'));
  assert.ok(!items[0].bound.test('https://github.com/SonarSource/sonar-sca/pull/25612'));
});

test('rejects unexpected gh output', async () => {
  await assert.rejects(fetchReviewRequests('gh', [], async () => ({ stdout: '{}' })));
  await assert.rejects(
    fetchReviewRequests('gh', [], async () => ({ stdout: JSON.stringify([{ title: 'x' }]) })),
  );
});

test('pages Jira issues and treats "No result found" as empty', async () => {
  const pages: string[] = [];
  const full = Array.from({ length: 100 }, (_, index) => ({
    ...ISSUE,
    key: `SCA-${index + 1}`,
  }));
  const items = await fetchAssignedIssues('jira', 'https://jira.example', async (_c, args) => {
    const page = args[args.indexOf('--paginate') + 1];
    pages.push(page);
    if (page === '0:100') return { stdout: JSON.stringify(full) };
    throw Object.assign(new Error('exit 1'), { stderr: 'No result found for given query' });
  });
  assert.deepEqual(pages, ['0:100', '100:100']);
  assert.equal(items.length, 100);
  assert.match(items[0].body, /^\[SCA-1\]\(https:\/\/jira\.example\/browse\/SCA-1\)/);
  assert.ok(items[0].bound.test('SCA-1 work'));
  assert.ok(!items[0].bound.test('SCA-10 work'));
  assert.ok(!items[0].bound.test('XSCA-1 work'));
});

test('rejects Jira failures other than empty results', async () => {
  await assert.rejects(
    fetchAssignedIssues('jira', 'https://jira.example', async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'unauthorized' });
    }),
  );
  assert.throws(() => jiraOrigin('http://jira.example'));
  assert.equal(jiraOrigin('https://jira.example/path'), 'https://jira.example');
});

test('creates Triage cards only for unbound items, ignoring archive', async () => {
  const board = await tempBoard();
  await writeFile(join(board, 'existing.md'), '---\ncolumn: Todo\n---\n\nWorking on COSCA-149\n');
  await writeFile(join(board, 'archive', '2026-10', 'old.md'), `Old review ${PR.url}\n`);
  const [review] = await fetchReviewRequests('gh', [], async () => ({
    stdout: JSON.stringify([PR]),
  }));
  const [issue] = await fetchAssignedIssues('jira', 'https://jira.example', async () => ({
    stdout: JSON.stringify([ISSUE]),
  }));

  const created = await triageItems(board, [review, issue, review], NOW);

  assert.deepEqual(created, [join(board, 'review-sonar-sca-2561-sca-3340-bound-cpu-use.md')]);
  const { data, body } = parseFile(await readFile(created[0], 'utf8'));
  assert.equal(data.column, 'Triage');
  assert.equal(data.title, 'Review: sonar-sca#2561 SCA-3340 Bound CPU use');
  assert.equal(data.created, '2026-11-02T12:00:00.000Z');
  assert.match(String(data.uuid), /^[0-9a-f-]{36}$/);
  assert.ok(body.trimStart().startsWith(PR.url));
});

test('never overwrites a colliding filename', async () => {
  const board = await tempBoard();
  await writeFile(join(board, 'hello.md'), 'unrelated\n');
  const created = await triageItems(board, [{ title: 'Hello', body: 'x', bound: /nope/ }], NOW);
  assert.deepEqual(created, [join(board, 'hello-1.md')]);
  assert.equal(await readFile(join(board, 'hello.md'), 'utf8'), 'unrelated\n');
  assert.equal(slugify('  A/B: c!  '), 'a-b-c');
  assert.equal(slugify('!!!'), 'card');
});

test('runExtension skips unknown boards and missing executables', async () => {
  const board = await tempBoard();
  const boards = [{ uuid: 'b1', path: board, updatedAt: '' }];
  const debug = () => {};
  const githubRun = async () => ({ stdout: JSON.stringify([PR]) });
  assert.deepEqual(
    await runExtension(
      'github-assignment',
      { boardUuid: 'other' },
      { boards, debug, githubPath: 'gh', githubRun },
    ),
    [],
  );
  assert.deepEqual(
    await runExtension('github-assignment', { boardUuid: 'b1' }, { boards, debug }),
    [],
  );
  const created = await runExtension(
    'github-assignment',
    { boardUuid: 'b1' },
    { boards, debug, githubPath: 'gh', githubRun },
  );
  assert.equal(created.length, 1);
  assert.equal((await readdir(board)).filter((name) => name.endsWith('.md')).length, 1);
});
