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

const review = (pr: typeof PR, reviewer: 'user' | 'team', repo = 'SonarSource/sonar-sca') => ({
  ...pr,
  repository: { nameWithOwner: repo },
  reviewRequests: {
    nodes: [{ requestedReviewer: reviewer === 'user' ? { login: 'me' } : {} }],
    pageInfo: { hasNextPage: false },
  },
});
const searchResult = (nodes: unknown[], hasNextPage = false) => ({
  data: { viewer: { login: 'me' }, search: { nodes, pageInfo: { hasNextPage } } },
});

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

test('one GraphQL search keeps direct requests and other requests only in approved repositories', async () => {
  const calls: string[][] = [];
  const teamPr = { ...PR, url: 'https://github.com/SonarSource/sonarcloud-webapp/pull/42' };
  const excluded = { ...PR, url: 'https://github.com/SonarSource/sonar-sca/pull/99' };
  const items = await fetchReviewRequests(
    'gh',
    ['SonarSource'],
    async (_command, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify(
          searchResult([
            review(PR, 'user'),
            review(teamPr, 'team', 'SonarSource/sonarcloud-webapp'),
            review(excluded, 'team'),
          ]),
        ),
      };
    },
    ['SONARSOURCE/sonarcloud-*'],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['api', 'graphql', '-f']);
  assert.match(calls[0][3], /review-requested:@me/);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Review: sonar-sca#2561 SCA-3340 Bound CPU use');
  assert.match(items[0].body, /\| Draft \| yes \|/);
  assert.ok(items[0].bound.test('see https://github.com/sonarsource/sonar-sca/pull/2561.'));
  assert.ok(!items[0].bound.test('https://github.com/SonarSource/sonar-sca/pull/25612'));
  assert.ok(items[1].body.includes(teamPr.url));
});

test('ignored repository globs override direct requests and included repository globs', async () => {
  const personal = { ...PR, url: 'https://github.com/subdavis/my-repo/pull/1' };
  const personalTeam = { ...PR, url: 'https://github.com/subdavis/another/pull/2' };
  const approved = { ...PR, url: 'https://github.com/SonarSource/sonarcloud-webapp/pull/3' };
  const items = await fetchReviewRequests(
    'gh',
    [],
    async () => ({
      stdout: JSON.stringify(
        searchResult([
          review(personal, 'user', 'subdavis/my-repo'),
          review(personalTeam, 'team', 'subdavis/another'),
          review(approved, 'team', 'SonarSource/sonarcloud-webapp'),
        ]),
      ),
    }),
    ['subdavis/*', 'SonarSource/sonarcloud-*'],
    ['SubDavis/*'],
  );
  assert.deepEqual(
    items.map((item) => item.body.split('\n')[0]),
    [approved.url],
  );
});

test('rejects incomplete GraphQL output rather than silently missing reviews', async () => {
  await assert.rejects(fetchReviewRequests('gh', [], async () => ({ stdout: '{}' })));
  await assert.rejects(
    fetchReviewRequests('gh', [], async () => ({ stdout: JSON.stringify(searchResult([], true)) })),
  );
  await assert.rejects(
    fetchReviewRequests('gh', [], async () => ({
      stdout: JSON.stringify(
        searchResult([{ ...review(PR, 'user'), reviewRequests: { nodes: [] } }]),
      ),
    })),
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
  const [item] = await fetchReviewRequests('gh', [], async () => ({
    stdout: JSON.stringify(searchResult([review(PR, 'user')])),
  }));
  const [issue] = await fetchAssignedIssues('jira', 'https://jira.example', async () => ({
    stdout: JSON.stringify([ISSUE]),
  }));

  const created = await triageItems(board, [item, issue, item], NOW);

  assert.deepEqual(created, [join(board, 'review-sonar-sca-2561-sca-3340-bound-cpu-use.md')]);
  const { data, body } = parseFile(await readFile(created[0], 'utf8'));
  assert.equal(data.column, 'Triage');
  assert.equal(data.title, 'Review: sonar-sca#2561 SCA-3340 Bound CPU use');
  assert.equal(data.created, '2026-11-02T12:00:00.000Z');
  assert.match(String(data.uuid), /^[0-9a-f-]{36}$/);
  assert.ok(body.trimStart().startsWith(PR.url));
  assert.equal(
    await readFile(join(board, 'existing.md'), 'utf8'),
    '---\ncolumn: Todo\n---\n\nWorking on COSCA-149\n',
  );
});

test('GitHub review requests move existing cards to Triage without changing their content', async () => {
  const board = await tempBoard();
  const path = join(board, 'existing.md');
  await writeFile(
    path,
    `---\nuuid: existing-id\ntitle: Existing task\ncolumn: Doing\n---\n\nCheck ${PR.url}\n`,
  );
  const boards = [{ uuid: 'b1', path: board, updatedAt: '' }];
  const context = {
    boards,
    debug: () => {},
    githubPath: 'gh',
    githubRun: async () => ({ stdout: JSON.stringify(searchResult([review(PR, 'user')])) }),
  };

  assert.deepEqual(await runExtension('github-assignment', { boardUuid: 'b1' }, context), []);
  const moved = await readFile(path, 'utf8');
  const { data, body } = parseFile(moved);
  assert.equal(data.column, 'Triage');
  assert.equal(data.uuid, 'existing-id');
  assert.equal(data.title, 'Existing task');
  assert.equal(body.trimStart(), `Check ${PR.url}\n`);
  assert.deepEqual(await runExtension('github-assignment', { boardUuid: 'b1' }, context), []);
  assert.equal(await readFile(path, 'utf8'), moved);
  assert.equal((await readdir(board)).filter((name) => name.endsWith('.md')).length, 1);
});

test('Jira triage reports linked cards without moving them', async () => {
  const board = await tempBoard();
  const path = join(board, 'issue.md');
  await writeFile(path, '---\ncolumn: Doing\n---\n\nCOSCA-149\n');
  const outcomes: Array<{ title: string; cards: Array<{ path: string; action: string }> }> = [];
  await runExtension(
    'jira-assignment',
    { boardUuid: 'b1', server: 'https://jira.example' },
    {
      boards: [{ uuid: 'b1', path: board, updatedAt: '' }],
      debug: () => {},
      jiraPath: 'jira',
      jiraRun: async () => ({ stdout: JSON.stringify([ISSUE]) }),
    },
    ({ item, cards }) => outcomes.push({ title: item.title, cards }),
  );
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0].cards, [{ path, action: 'linked' }]);
  assert.match(await readFile(path, 'utf8'), /column: Doing/);
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
  const githubRun = async () => ({ stdout: JSON.stringify(searchResult([review(PR, 'user')])) });
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
  const calls: string[][] = [];
  const ignored = await runExtension(
    'github-assignment',
    {
      boardUuid: 'b1',
      reviewRepositories: ['SonarSource/sonarcloud-*'],
      ignoreRepositories: ['subdavis/*'],
    },
    {
      boards,
      debug,
      githubPath: 'gh',
      githubRun: async (_command, args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify(
            searchResult([
              review(
                { ...PR, url: 'https://github.com/subdavis/test/pull/1' },
                'user',
                'subdavis/test',
              ),
            ]),
          ),
        };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['api', 'graphql']);
  assert.deepEqual(ignored, []);
});
