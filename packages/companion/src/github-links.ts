import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EnrichmentProvider } from './enrichment-stream.ts';

const exec = promisify(execFile);
const MAX_URLS = 50;
const GITHUB_ITEM_URL =
  /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/;

export type GitHubLinkStatus = 'open' | 'closed' | 'merged' | 'draft';
export type GitHubCiStatus = 'passing' | 'failing' | 'pending' | 'none';

export interface GitHubLink {
  url: string;
  number: number;
  title: string;
  status: GitHubLinkStatus;
  ciStatus?: GitHubCiStatus;
}

export interface GitHubLinkLookupResult {
  items: GitHubLink[];
  errors: Array<{ url: string; error: 'lookup_failed' }>;
}

export type GitHubLinkResultListener = (result: GitHubLinkLookupResult) => void;

interface CommandResult {
  stdout: string;
}

export type GitHubCommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

interface GitHubView {
  isDraft?: unknown;
  number?: unknown;
  state?: unknown;
  statusCheckRollup?: unknown;
  title?: unknown;
}

const FAILING_CHECK_STATES = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'ERROR',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);
const PENDING_CHECK_STATES = new Set([
  'EXPECTED',
  'IN_PROGRESS',
  'PENDING',
  'QUEUED',
  'REQUESTED',
  'WAITING',
]);

export function isGitHubLinkUrl(url: string): boolean {
  return GITHUB_ITEM_URL.test(url);
}

export function parseGitHubLinkUrls(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const urls = (value as { urls?: unknown }).urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_URLS) return undefined;
  if (urls.some((url) => typeof url !== 'string' || !isGitHubLinkUrl(url))) return undefined;
  return [...new Set(urls as string[])];
}

function statusOf(value: GitHubView): GitHubLinkStatus | undefined {
  if (value.isDraft === true) return 'draft';
  if (value.state === 'OPEN') return 'open';
  if (value.state === 'CLOSED') return 'closed';
  if (value.state === 'MERGED') return 'merged';
  return undefined;
}

function checkState(check: unknown): GitHubCiStatus {
  if (!check || typeof check !== 'object') return 'pending';
  const values = ['conclusion', 'state', 'status']
    .map((key) => (check as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string');
  if (values.some((value) => FAILING_CHECK_STATES.has(value))) return 'failing';
  if (values.some((value) => PENDING_CHECK_STATES.has(value))) return 'pending';
  return 'passing';
}

function ciStatusOf(value: GitHubView): GitHubCiStatus {
  if (!Array.isArray(value.statusCheckRollup) || value.statusCheckRollup.length === 0)
    return 'none';
  const states = value.statusCheckRollup.map(checkState);
  if (states.includes('failing')) return 'failing';
  if (states.includes('pending')) return 'pending';
  return 'passing';
}

function parseView(stdout: string, requestedUrl: string): GitHubLink {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object') throw new Error('gh view returned invalid JSON');
  const view = value as GitHubView;
  const status = statusOf(view);
  if (typeof view.number !== 'number' || typeof view.title !== 'string' || !view.title || !status) {
    throw new Error('gh view returned incomplete JSON');
  }
  const activePullRequest = requestedUrl.includes('/pull/') && ['open', 'draft'].includes(status);
  return {
    url: requestedUrl,
    number: view.number,
    title: view.title,
    status,
    ...(activePullRequest && { ciStatus: ciStatusOf(view) }),
  };
}

function viewArgs(url: string): string[] {
  const match = GITHUB_ITEM_URL.exec(url);
  if (!match) throw new Error('Invalid GitHub URL');
  return match[3] === 'pull'
    ? ['pr', 'view', url, '--json', 'isDraft,number,state,statusCheckRollup,title']
    : ['issue', 'view', url, '--json', 'number,state,title'];
}

export async function fetchGitHubLinks(
  urls: string[],
  githubPath: string,
  run: GitHubCommandRunner = (command, args) => exec(command, args),
  onResult?: GitHubLinkResultListener,
): Promise<GitHubLinkLookupResult> {
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const item = parseView((await run(githubPath, viewArgs(url))).stdout, url);
        onResult?.({ items: [item], errors: [] });
        return item;
      } catch (error) {
        onResult?.({ items: [], errors: [{ url, error: 'lookup_failed' }] });
        throw error;
      }
    }),
  );
  const items: GitHubLink[] = [];
  const errors: GitHubLinkLookupResult['errors'] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') items.push(result.value);
    else errors.push({ url: urls[index], error: 'lookup_failed' });
  });
  return { items, errors };
}

export function createGitHubEnrichmentProvider(
  githubPath: string,
  run?: GitHubCommandRunner,
): EnrichmentProvider {
  return {
    name: 'github',
    supports: isGitHubLinkUrl,
    refresh: async (urls, onResult) => {
      await fetchGitHubLinks(urls, githubPath, run, (result) => {
        onResult({
          items: result.items.map((item) => ({ ...item, provider: 'github' })),
          errors: result.errors.map((error) => ({ ...error, provider: 'github' })),
        });
      });
    },
  };
}
