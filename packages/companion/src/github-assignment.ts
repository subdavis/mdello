import { execFile } from 'node:child_process';
import { matchesGlob } from 'node:path';
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
  repository?: { nameWithOwner?: unknown };
  reviewRequests?: {
    nodes?: Array<{ requestedReviewer?: { login?: unknown } }>;
    pageInfo?: { hasNextPage?: boolean };
  };
}

const QUERY = `query {
  viewer { login }
  search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 100) {
    pageInfo { hasNextPage }
    nodes {
      ... on PullRequest {
        url title isDraft updatedAt
        author { login }
        repository { nameWithOwner }
        reviewRequests(first: 100) {
          pageInfo { hasNextPage }
          nodes { requestedReviewer { ... on User { login } } }
        }
      }
    }
  }
}`;

function parseItem(value: SearchResult): TriageItem {
  const match = typeof value.url === 'string' ? PULL_URL.exec(value.url) : null;
  if (!match || typeof value.title !== 'string' || !value.title) {
    throw new Error('gh api graphql returned an unexpected pull request');
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

/** One search for review requests; ignored repositories always take precedence. */
export async function fetchReviewRequests(
  githubPath: string,
  organizations: string[],
  run: GitHubCommandRunner = (command, args) => exec(command, args),
  reviewRepositories: string[] = [],
  ignoreRepositories: string[] = [],
): Promise<TriageItem[]> {
  const value: unknown = JSON.parse(
    (await run(githubPath, ['api', 'graphql', '-f', `query=${QUERY}`])).stdout,
  );
  const data = (
    value as {
      data?: {
        viewer?: { login?: unknown };
        search?: { nodes?: SearchResult[]; pageInfo?: { hasNextPage?: boolean } };
      };
    }
  )?.data;
  if (
    typeof data?.viewer?.login !== 'string' ||
    !Array.isArray(data.search?.nodes) ||
    data.search.pageInfo?.hasNextPage !== false
  ) {
    throw new Error('gh api graphql returned an unexpected or incomplete search');
  }
  const login = data.viewer.login.toLowerCase();
  const owners = organizations.map((owner) => owner.toLowerCase());
  const includes = reviewRepositories.map((pattern) => pattern.toLowerCase());
  const excludes = ignoreRepositories.map((pattern) => pattern.toLowerCase());
  return data.search.nodes
    .filter((entry) => {
      const repo = entry?.repository?.nameWithOwner;
      const reviewers = entry?.reviewRequests;
      if (
        typeof repo !== 'string' ||
        !Array.isArray(reviewers?.nodes) ||
        reviewers.pageInfo?.hasNextPage !== false
      ) {
        throw new Error('gh api graphql returned an unexpected or incomplete review request');
      }
      const name = repo.toLowerCase();
      return (
        !excludes.some((pattern) => matchesGlob(name, pattern)) &&
        (includes.some((pattern) => matchesGlob(name, pattern)) ||
          ((!owners.length || owners.includes(repo.split('/')[0].toLowerCase())) &&
            reviewers.nodes.some(
              (request) =>
                typeof request?.requestedReviewer?.login === 'string' &&
                request.requestedReviewer.login.toLowerCase() === login,
            )))
      );
    })
    .map(parseItem);
}
