import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJiraLinks, parseJiraLinkUrls } from './jira-links.ts';

test('validates and deduplicates batches of Jira issue URLs', () => {
  assert.deepEqual(
    parseJiraLinkUrls({
      urls: [
        'https://sonarsource.atlassian.net/browse/SCA-1234',
        'https://sonarsource.atlassian.net/browse/SONAR-42',
        'https://sonarsource.atlassian.net/browse/SCA-1234',
      ],
    }),
    [
      'https://sonarsource.atlassian.net/browse/SCA-1234',
      'https://sonarsource.atlassian.net/browse/SONAR-42',
    ],
  );
  assert.equal(parseJiraLinkUrls({ urls: [] }), undefined);
  assert.equal(parseJiraLinkUrls({ urls: ['https://example.com/browse/SCA-1234'] }), undefined);
});

test('fetches Jira issues through jira and retains partial results', async () => {
  const calls: Array<[string, string[]]> = [];
  const urls = [
    'https://sonarsource.atlassian.net/browse/SCA-1234',
    'https://sonarsource.atlassian.net/browse/SONAR-42',
  ];
  const result = await fetchJiraLinks(urls, '/usr/local/bin/jira', async (command, args) => {
    calls.push([command, args]);
    if (args[2] === 'SONAR-42') throw new Error('not found');
    return {
      stdout: JSON.stringify({
        key: 'SCA-1234',
        fields: { summary: 'Add Jira enrichment', status: { name: 'In Progress' } },
      }),
    };
  });

  assert.deepEqual(result, {
    items: [
      {
        url: urls[0],
        key: 'SCA-1234',
        status: 'In Progress',
        title: 'Add Jira enrichment',
      },
    ],
    errors: [{ url: urls[1], error: 'lookup_failed' }],
  });
  assert.deepEqual(calls[0], ['/usr/local/bin/jira', ['issue', 'view', 'SCA-1234', '--raw']]);
});

test('publishes each Jira lookup result as soon as it settles', async () => {
  const urls = [
    'https://sonarsource.atlassian.net/browse/SCA-1',
    'https://sonarsource.atlassian.net/browse/SCA-2',
  ];
  const published: string[] = [];
  await fetchJiraLinks(
    urls,
    'jira',
    async (_command, args) => {
      const key = args[2] ?? '';
      if (key === 'SCA-1') await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        stdout: JSON.stringify({
          key,
          fields: { summary: `Issue ${key}`, status: { name: 'Open' } },
        }),
      };
    },
    (result) => published.push(result.items[0]?.url ?? result.errors[0]?.url ?? ''),
  );

  assert.deepEqual(published, [urls[1], urls[0]]);
});
