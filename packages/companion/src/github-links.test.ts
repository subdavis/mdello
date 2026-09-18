import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGitHubLinks, parseGitHubLinkUrls } from './github-links.ts';

test('validates and deduplicates batches of GitHub PR and issue URLs', () => {
  assert.deepEqual(
    parseGitHubLinkUrls({
      urls: [
        'https://github.com/owner/repo/pull/12',
        'https://github.com/owner/repo/issues/34',
        'https://github.com/owner/repo/pull/12',
      ],
    }),
    ['https://github.com/owner/repo/pull/12', 'https://github.com/owner/repo/issues/34'],
  );
  assert.equal(parseGitHubLinkUrls({ urls: [] }), undefined);
  assert.equal(
    parseGitHubLinkUrls({ urls: ['https://example.com/owner/repo/pull/12'] }),
    undefined,
  );
});

test('fetches GitHub links through gh and retains partial results', async () => {
  const calls: Array<[string, string[]]> = [];
  const urls = [
    'https://github.com/owner/repo/pull/12',
    'https://github.com/owner/repo/issues/34',
    'https://github.com/owner/repo/issues/56',
  ];
  const result = await fetchGitHubLinks(urls, '/usr/local/bin/gh', async (command, args) => {
    calls.push([command, args]);
    if (args[2]?.endsWith('/56')) throw new Error('not found');
    return {
      stdout: JSON.stringify({
        number: Number(args[2]?.split('/').at(-1)),
        title: args[0] === 'pr' ? 'Add feature' : 'Fix bug',
        state: args[0] === 'pr' ? 'MERGED' : 'OPEN',
      }),
    };
  });

  assert.deepEqual(result, {
    items: [
      { url: urls[0], number: 12, title: 'Add feature', status: 'merged' },
      { url: urls[1], number: 34, title: 'Fix bug', status: 'open' },
    ],
    errors: [{ url: urls[2], error: 'lookup_failed' }],
  });
  assert.deepEqual(calls[0], [
    '/usr/local/bin/gh',
    ['pr', 'view', urls[0], '--json', 'isDraft,number,state,statusCheckRollup,title'],
  ]);
});

test('publishes each lookup result as soon as it settles', async () => {
  const urls = ['https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/issues/2'];
  const published: string[] = [];
  await fetchGitHubLinks(
    urls,
    'gh',
    async (_command, args) => {
      const url = args[2] ?? '';
      if (url.endsWith('/1')) await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        stdout: JSON.stringify({ number: Number(url.at(-1)), title: url, state: 'OPEN' }),
      };
    },
    (result) => published.push(result.items[0]?.url ?? result.errors[0]?.url ?? ''),
  );

  assert.deepEqual(published, [urls[1], urls[0]]);
});

test('reports aggregate CI state only for active pull requests', async () => {
  const urls = [1, 2, 3, 4, 5].map((number) => `https://github.com/owner/repo/pull/${number}`);
  const rollups = [
    [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    [{ status: 'IN_PROGRESS', conclusion: null }],
    [],
    [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ];
  const items = await fetchGitHubLinks(urls, 'gh', async (_command, args) => {
    const number = Number(args[2]?.split('/').at(-1));
    return {
      stdout: JSON.stringify({
        number,
        title: `PR ${number}`,
        state: number === 5 ? 'CLOSED' : 'OPEN',
        statusCheckRollup: rollups[number - 1],
      }),
    };
  });

  assert.deepEqual(
    items.items.map(({ ciStatus }) => ciStatus),
    ['passing', 'failing', 'pending', 'none', undefined],
  );
});
