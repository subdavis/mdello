import { Cron } from 'croner';
import type { BoardRegistration, CompanionConfig } from './boards.ts';
import { readBoardColumns } from './boards.ts';
import type { DebugLogger } from './debug.ts';
import {
  type CommandRunner,
  parseGitHubAssignmentConfig,
  syncGitHubAssignments,
} from './github-assignment.ts';

export interface ScheduledJob {
  stop(): void;
}

export type Schedule = (
  pattern: string,
  task: () => Promise<void>,
  onBlocked: () => void,
  onError: (error: unknown) => void,
) => ScheduledJob;

export interface ExtensionDependencies {
  debug: DebugLogger;
  run?: CommandRunner;
  schedule?: Schedule;
}

function defaultSchedule(
  pattern: string,
  task: () => Promise<void>,
  onBlocked: () => void,
  onError: (error: unknown) => void,
): ScheduledJob {
  return new Cron(pattern, { catch: onError, protect: onBlocked }, task);
}

export async function startCompanionExtensions(
  config: Partial<CompanionConfig>,
  boards: BoardRegistration[],
  dependencies: ExtensionDependencies,
): Promise<ScheduledJob> {
  const jobs: ScheduledJob[] = [];
  const rawConfig = config.extensions?.['github-assignment'];
  try {
    const githubConfig = parseGitHubAssignmentConfig(rawConfig);
    if (githubConfig) {
      const board = boards.find(({ uuid }) => uuid === githubConfig.boardUuid);
      if (!board) {
        throw new Error(
          `extensions.github-assignment.boardUuid does not match a registered board: ${githubConfig.boardUuid}`,
        );
      }
      const columns = await readBoardColumns(board.path);
      if (!columns.includes('Triage')) {
        throw new Error(`GitHub assignment board has no Triage column: ${board.path}`);
      }

      const onError = (error: unknown) =>
        dependencies.debug('GitHub assignment sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      const job = (dependencies.schedule ?? defaultSchedule)(
        githubConfig.schedule,
        async () => {
          await syncGitHubAssignments({
            config: githubConfig,
            boardPath: board.path,
            run: dependencies.run,
            debug: dependencies.debug,
          });
        },
        () => dependencies.debug('GitHub assignment sync skipped because previous run is active'),
        onError,
      );
      jobs.push(job);
      dependencies.debug('GitHub assignment extension scheduled', {
        schedule: githubConfig.schedule,
        organizations: githubConfig.organizations,
        boardUuid: githubConfig.boardUuid,
      });
    }
  } catch (error) {
    dependencies.debug('GitHub assignment extension disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    stop(): void {
      for (const job of jobs) job.stop();
    },
  };
}
