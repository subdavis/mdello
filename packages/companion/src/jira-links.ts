import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EnrichmentProvider } from './enrichment-stream.ts';

const exec = promisify(execFile);
const MAX_URLS = 50;
const JIRA_ISSUE_URL =
  /^https:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/;

export interface JiraLink {
  url: string;
  key: string;
  status: string;
  title: string;
}

export interface JiraLinkLookupResult {
  items: JiraLink[];
  errors: Array<{ url: string; error: 'lookup_failed' }>;
}

export type JiraLinkResultListener = (result: JiraLinkLookupResult) => void;

interface CommandResult {
  stdout: string;
}

export type JiraCommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

interface JiraView {
  key?: unknown;
  fields?: {
    summary?: unknown;
    status?: { name?: unknown };
  };
}

export function isJiraLinkUrl(url: string): boolean {
  return JIRA_ISSUE_URL.test(url);
}

export function parseJiraLinkUrls(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const urls = (value as { urls?: unknown }).urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_URLS) return undefined;
  if (urls.some((url) => typeof url !== 'string' || !isJiraLinkUrl(url))) return undefined;
  return [...new Set(urls as string[])];
}

function issueKey(url: string): string {
  const match = JIRA_ISSUE_URL.exec(url);
  if (!match) throw new Error('Invalid Jira URL');
  return match[1];
}

function parseView(stdout: string, requestedUrl: string): JiraLink {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object') throw new Error('jira view returned invalid JSON');
  const view = value as JiraView;
  const status = view.fields?.status?.name;
  const title = view.fields?.summary;
  if (
    typeof view.key !== 'string' ||
    !view.key ||
    typeof status !== 'string' ||
    !status ||
    typeof title !== 'string' ||
    !title
  ) {
    throw new Error('jira view returned incomplete JSON');
  }
  return { url: requestedUrl, key: view.key, status, title };
}

export async function fetchJiraLinks(
  urls: string[],
  jiraPath: string,
  run: JiraCommandRunner = (command, args) => exec(command, args),
  onResult?: JiraLinkResultListener,
): Promise<JiraLinkLookupResult> {
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const item = parseView(
          (await run(jiraPath, ['issue', 'view', issueKey(url), '--raw'])).stdout,
          url,
        );
        onResult?.({ items: [item], errors: [] });
        return item;
      } catch (error) {
        onResult?.({ items: [], errors: [{ url, error: 'lookup_failed' }] });
        throw error;
      }
    }),
  );
  const items: JiraLink[] = [];
  const errors: JiraLinkLookupResult['errors'] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') items.push(result.value);
    else errors.push({ url: urls[index], error: 'lookup_failed' });
  });
  return { items, errors };
}

export function createJiraEnrichmentProvider(
  jiraPath: string,
  run?: JiraCommandRunner,
): EnrichmentProvider {
  return {
    name: 'jira',
    supports: isJiraLinkUrl,
    refresh: async (urls, onResult) => {
      await fetchJiraLinks(urls, jiraPath, run, (result) => {
        onResult({
          items: result.items.map((item) => ({ ...item, provider: 'jira' })),
          errors: result.errors.map((error) => ({ ...error, provider: 'jira' })),
        });
      });
    },
  };
}
