import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubCommandRunner } from './github-links.ts';
import { escapeRegExp, markdownTable, type TriageItem } from './triage.ts';

const exec = promisify(execFile);
const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;

interface SearchResult {
  url?: unknown;
  title?: unknown;
  isDraft?: unknown;
  updatedAt?: unknown;
  author?: { login?: unknown };
}

function parseItem(value: SearchResult): TriageItem {
  const match = typeof value.url === 'string' ? PULL_URL.exec(value.url) : null;
  if (!match || typeof value.title !== 'string' || !value.title) {
    throw new Error('gh search prs returned an unexpected item');
  }
  const [url, owner, repo, number] = match;
  const author = typeof value.author?.login === 'string' ? value.author.login : undefined;
  const table = markdownTable('GitHub field', [
    ['Repository', `${owner}/${repo}`],
    ['Author', author],
    ['Draft', value.isDraft === true ? 'yes' : 'no'],
    ['Updated', typeof value.updatedAt === 'string' ? value.updatedAt : undefined],
  ]);
  return {
    title: `Review: ${repo}#${number} ${value.title}`,
    body: `${url}\n\n${table}\n`,
    bound: new RegExp(
      `github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/pull/${number}(?!\\d)`,
      'i',
    ),
  };
}

/** Open PRs requesting my review directly, drafts included. Throws on any unexpected output. */
export async function fetchReviewRequests(
  githubPath: string,
  organizations: string[],
  run: GitHubCommandRunner = (command, args) => exec(command, args),
): Promise<TriageItem[]> {
  const args = [
    'search',
    'prs',
    // Unlike --review-requested, excludes requests made only to my teams.
    'user-review-requested:@me',
    '--state=open',
    '--json',
    'url,title,isDraft,updatedAt,author',
    '--limit',
    '100',
    ...organizations.flatMap((organization) => ['--owner', organization]),
  ];
  const value: unknown = JSON.parse((await run(githubPath, args)).stdout);
  if (!Array.isArray(value)) throw new Error('gh search prs did not return an array');
  return value.map((entry: SearchResult) => parseItem(entry ?? {}));
}
