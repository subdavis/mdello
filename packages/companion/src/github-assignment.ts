import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serializeFile } from '@mdello/common/frontmatter';
import type { DebugLogger } from './debug.ts';

const exec = promisify(execFile);
const JSON_FIELDS = 'author,body,labels,number,repository,state,title,updatedAt,url';
const RESULT_LIMIT = '1000';

export interface GitHubAssignmentConfig {
  schedule: string;
  organizations: string[];
  boardUuid: string;
}

export interface GitHubAssignmentItem {
  url: string;
  title: string;
  kind: 'assigned' | 'review-requested';
  repository?: string;
  number?: number;
  author?: string;
  labels: string[];
  state?: string;
  updatedAt?: string;
  body?: string;
}

export interface CommandResult {
  stdout: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

interface SearchItem {
  author?: { login?: unknown };
  body?: unknown;
  labels?: { name?: unknown }[];
  number?: unknown;
  repository?: { nameWithOwner?: unknown };
  state?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  url?: unknown;
}

export function parseGitHubAssignmentConfig(value: unknown): GitHubAssignmentConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error('extensions.github-assignment must be an object');
  }

  const candidate = value as Partial<GitHubAssignmentConfig>;
  if (typeof candidate.schedule !== 'string' || !candidate.schedule.trim()) {
    throw new Error('extensions.github-assignment.schedule must be a non-empty cron expression');
  }
  if (
    !Array.isArray(candidate.organizations) ||
    candidate.organizations.some(
      (organization) => typeof organization !== 'string' || !organization.trim(),
    )
  ) {
    throw new Error('extensions.github-assignment.organizations must be an array of names');
  }
  if (typeof candidate.boardUuid !== 'string' || !candidate.boardUuid.trim()) {
    throw new Error('extensions.github-assignment.boardUuid must be a non-empty string');
  }

  return {
    schedule: candidate.schedule.trim(),
    organizations: candidate.organizations.map((organization) => organization.trim()),
    boardUuid: candidate.boardUuid.trim(),
  };
}

function defaultRun(command: string, args: string[]): Promise<CommandResult> {
  return exec(command === 'gh' ? (process.env.GH_PATH ?? command) : command, args);
}

function searchArgs(type: 'issues' | 'prs', filter: string[], organizations: string[]): string[] {
  return [
    'search',
    type,
    ...filter,
    '--state',
    'open',
    '--limit',
    RESULT_LIMIT,
    '--json',
    JSON_FIELDS,
    ...organizations.flatMap((organization) => ['--owner', organization]),
  ];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeItem(
  value: SearchItem,
  kind: GitHubAssignmentItem['kind'],
): GitHubAssignmentItem | undefined {
  const url = stringValue(value.url);
  const title = stringValue(value.title);
  if (!url || !title) return undefined;

  return {
    url,
    title,
    kind,
    repository: stringValue(value.repository?.nameWithOwner),
    number: typeof value.number === 'number' ? value.number : undefined,
    author: stringValue(value.author?.login),
    labels: Array.isArray(value.labels)
      ? value.labels.flatMap((label) => {
          const name = stringValue(label.name);
          return name ? [name] : [];
        })
      : [],
    state: stringValue(value.state),
    updatedAt: stringValue(value.updatedAt),
    body: stringValue(value.body),
  };
}

function parseSearch(stdout: string, kind: GitHubAssignmentItem['kind']): GitHubAssignmentItem[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('gh search returned non-array JSON');
  return parsed.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = normalizeItem(value as SearchItem, kind);
    return item ? [item] : [];
  });
}

export async function discoverGitHubAssignments(
  config: Pick<GitHubAssignmentConfig, 'organizations'>,
  run: CommandRunner = defaultRun,
): Promise<GitHubAssignmentItem[]> {
  const searches = await Promise.all([
    run('gh', searchArgs('issues', ['--assignee', '@me'], config.organizations)),
    run('gh', searchArgs('prs', ['--assignee', '@me'], config.organizations)),
    run('gh', searchArgs('prs', ['user-review-requested:@me'], config.organizations)),
  ]);

  const merged = new Map<string, GitHubAssignmentItem>();
  for (const item of [
    ...parseSearch(searches[0].stdout, 'assigned'),
    ...parseSearch(searches[1].stdout, 'assigned'),
    ...parseSearch(searches[2].stdout, 'review-requested'),
  ]) {
    const existing = merged.get(item.url);
    if (!existing || item.kind === 'review-requested') merged.set(item.url, item);
  }
  return [...merged.values()];
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
  return slug || 'github-item';
}

function cardTitle(item: GitHubAssignmentItem): string {
  const prefix = item.kind === 'review-requested' ? 'Review Requested' : 'Issue Assigned';
  return `${prefix}: ${item.title}`;
}

function cardBody(item: GitHubAssignmentItem): string {
  const details = [
    item.repository ? `- Repository: ${item.repository}` : undefined,
    item.number !== undefined ? `- Number: #${item.number}` : undefined,
    item.author ? `- Author: @${item.author}` : undefined,
    item.state ? `- State: ${item.state}` : undefined,
    item.updatedAt ? `- Updated: ${item.updatedAt}` : undefined,
    item.labels.length > 0 ? `- Labels: ${item.labels.join(', ')}` : undefined,
  ].filter((value): value is string => value !== undefined);
  const fullDescription = item.body?.trim();
  const description =
    fullDescription && fullDescription.length > 2_000
      ? `${fullDescription.slice(0, 2_000)}…`
      : fullDescription;
  return [item.url, details.length > 0 ? details.join('\n') : undefined, description]
    .filter(Boolean)
    .join('\n\n');
}

async function existingCardUrls(boardPath: string): Promise<Set<string>> {
  const entries = await readdir(boardPath, { withFileTypes: true });
  const contents = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => readFile(resolve(boardPath, entry.name), 'utf8')),
  );
  const urls = new Set<string>();
  for (const content of contents) {
    for (const match of content.matchAll(
      /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+/g,
    )) {
      urls.add(match[0]);
    }
  }
  return urls;
}

async function writeCard(
  boardPath: string,
  item: GitHubAssignmentItem,
  now: () => Date,
  uuid: () => string,
): Promise<string> {
  const title = cardTitle(item);
  const content = serializeFile(
    {
      uuid: uuid(),
      title,
      column: 'Triage',
      tags: [],
      created: now().toISOString(),
    },
    cardBody(item),
  );
  const base = slugify(title);
  for (let suffix = 0; ; suffix += 1) {
    const ending = suffix === 0 ? '' : `-${suffix}`;
    const filename = `${base.slice(0, 60 - ending.length)}${ending}.md`;
    const path = resolve(boardPath, filename);
    try {
      await writeFile(path, content, { flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export interface SyncGitHubAssignmentsOptions {
  config: GitHubAssignmentConfig;
  boardPath: string;
  run?: CommandRunner;
  now?: () => Date;
  uuid?: () => string;
  debug?: DebugLogger;
}

export async function syncGitHubAssignments(
  options: SyncGitHubAssignmentsOptions,
): Promise<string[]> {
  const items = await discoverGitHubAssignments(options.config, options.run);
  const urls = await existingCardUrls(options.boardPath);
  const created: string[] = [];
  for (const item of items) {
    if (urls.has(item.url)) continue;
    const path = await writeCard(
      options.boardPath,
      item,
      options.now ?? (() => new Date()),
      options.uuid ?? (() => crypto.randomUUID()),
    );
    urls.add(item.url);
    created.push(path);
  }
  options.debug?.('GitHub assignment sync completed', {
    board: basename(options.boardPath),
    discovered: items.length,
    created: created.length,
  });
  return created;
}
