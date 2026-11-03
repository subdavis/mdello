import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import type { JiraCommandRunner } from './jira-links.ts';
import { markdownTable, type TriageItem } from './triage.ts';

const exec = promisify(execFile);
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
// `project IS NOT EMPTY` stops jira-cli from silently scoping to its default project.
const JQL = 'project IS NOT EMPTY AND assignee = currentUser() AND statusCategory != Done';

interface ListedIssue {
  key?: unknown;
  fields?: {
    summary?: unknown;
    issueType?: { name?: unknown };
    status?: { name?: unknown };
    priority?: { name?: unknown };
    reporter?: { displayName?: unknown };
    updated?: unknown;
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** jira-cli's configured server origin, so the Jira host is never hardcoded. */
export async function readJiraServer(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configFile =
    environment.JIRA_CONFIG_FILE ||
    join(environment.XDG_CONFIG_HOME || join(homedir(), '.config'), '.jira', '.config.yml');
  const config = load(await readFile(configFile, 'utf8')) as { server?: unknown } | null;
  return jiraOrigin(config?.server);
}

export function jiraOrigin(server: unknown): string {
  if (typeof server !== 'string') throw new Error('Jira server is not configured');
  const url = new URL(server);
  if (url.protocol !== 'https:') throw new Error('Jira server must use https');
  return url.origin;
}

function parseIssue(issue: ListedIssue, server: string): TriageItem {
  const key = text(issue.key);
  const summary = text(issue.fields?.summary);
  if (!key || !KEY.test(key) || !summary) throw new Error('jira issue list returned bad issue');
  const fields = issue.fields ?? {};
  const table = markdownTable('Jira field', [
    ['Type', text(fields.issueType?.name)],
    ['Status', text(fields.status?.name)],
    ['Priority', text(fields.priority?.name)],
    ['Reporter', text(fields.reporter?.displayName)],
    ['Updated', text(fields.updated)],
  ]);
  return {
    title: `${key}: ${summary}`,
    body: `[${key}](${server}/browse/${key})\n\n${table}\n`,
    bound: new RegExp(`\\b${key}(?!\\d)`),
  };
}

/** jira-cli exits 1 with "No result found" instead of printing an empty array. */
async function listPage(jiraPath: string, args: string[], run: JiraCommandRunner) {
  try {
    return (await run(jiraPath, args)).stdout;
  } catch (error) {
    if (String((error as { stderr?: unknown }).stderr).includes('No result found')) return '[]';
    throw error;
  }
}

/** Active Jira issues assigned to me across every project. Throws on any unexpected output. */
export async function fetchAssignedIssues(
  jiraPath: string,
  server: string,
  run: JiraCommandRunner = (command, args) => exec(command, args),
): Promise<TriageItem[]> {
  const issues = new Map<string, TriageItem>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [
      ...['issue', 'list', '-q', JQL, '--order-by', 'updated'],
      ...['--paginate', `${page * PAGE_SIZE}:${PAGE_SIZE}`, '--raw'],
    ];
    const value: unknown = JSON.parse(await listPage(jiraPath, args, run));
    if (!Array.isArray(value)) throw new Error('jira issue list did not return an array');
    for (const issue of value) {
      issues.set(String(issue?.key), parseIssue(issue ?? {}, server));
    }
    if (value.length < PAGE_SIZE) break;
  }
  return [...issues.values()];
}
