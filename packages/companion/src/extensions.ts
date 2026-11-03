import { Cron } from 'croner';
import type { BoardRegistration } from './boards.ts';
import type { DebugLogger } from './debug.ts';
import { fetchReviewRequests } from './github-assignment.ts';
import type { GitHubCommandRunner } from './github-links.ts';
import { fetchAssignedIssues, jiraOrigin, readJiraServer } from './jira-assignment.ts';
import type { JiraCommandRunner } from './jira-links.ts';
import { type TriageItem, triageItems } from './triage.ts';

export interface ExtensionContext {
  /** Live registration list; boards are looked up on every run. */
  boards: BoardRegistration[];
  githubPath?: string;
  githubRun?: GitHubCommandRunner;
  jiraPath?: string;
  jiraRun?: JiraCommandRunner;
  environment?: NodeJS.ProcessEnv;
  debug: DebugLogger;
  log?: (message: string) => void;
}

type Settings = Record<string, unknown>;
type Fetcher = (settings: Settings, context: ExtensionContext) => Promise<TriageItem[]> | undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Each returns undefined when its executable is unavailable. */
const EXTENSIONS: Record<string, Fetcher> = {
  'github-assignment': (settings, { githubPath, githubRun }) =>
    githubPath
      ? fetchReviewRequests(githubPath, strings(settings.organizations), githubRun)
      : undefined,
  'jira-assignment': (settings, { jiraPath, jiraRun, environment }) =>
    jiraPath
      ? (settings.server === undefined
          ? readJiraServer(environment)
          : Promise.resolve(jiraOrigin(settings.server))
        ).then((server) => fetchAssignedIssues(jiraPath, server, jiraRun))
      : undefined,
};

export async function runExtension(
  name: string,
  settings: Settings,
  context: ExtensionContext,
): Promise<string[]> {
  const board = context.boards.find((entry) => entry.uuid === settings.boardUuid);
  if (!board) {
    context.debug('extension skipped: board not registered', { name });
    return [];
  }
  const fetching = EXTENSIONS[name]?.(settings, context);
  if (!fetching) {
    context.debug('extension skipped: executable unavailable', { name });
    return [];
  }
  const created = await triageItems(board.path, await fetching);
  context.debug('extension ran', { name, created: created.length });
  return created;
}

/** Schedules every valid configured extension, runs each once now, and returns a stop function. */
export function startExtensions(config: unknown, context: ExtensionContext): () => void {
  const log = context.log ?? console.error;
  const entries = config && typeof config === 'object' ? Object.entries(config) : [];
  const jobs: Cron[] = [];
  for (const [name, settings] of entries) {
    if (!EXTENSIONS[name] || !settings || typeof settings !== 'object') {
      context.debug('extension ignored', { name });
      continue;
    }
    const { schedule } = settings as Settings;
    // Overlapping runs could both pass dedup and write duplicate cards.
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await runExtension(name, settings as Settings, context);
      } catch (error) {
        log(`[mdello-companion] extension ${name} failed: ${String(error)}`);
      } finally {
        running = false;
      }
    };
    try {
      jobs.push(new Cron(String(schedule), run));
    } catch (error) {
      log(`[mdello-companion] extension ${name} has invalid schedule: ${String(error)}`);
      continue;
    }
    void run();
  }
  return () => {
    for (const job of jobs) job.stop();
  };
}
