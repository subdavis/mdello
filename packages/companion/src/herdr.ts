import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Association } from '@mdello/common/associations';
import type { ActionContext } from './actions.ts';
import { createDebugLogger } from './debug.ts';

const debug = createDebugLogger();
const exec = promisify(execFile);

type Session = Pick<Association, 'harness' | 'sessionId' | 'sessionFile'>;

interface HerdrAgent {
  agent_session?: { value?: string };
  tab_id?: string;
  workspace_id?: string;
}

interface HerdrTab {
  tab_id?: string;
  label?: string;
}

interface HerdrWorkspace {
  workspace_id?: string;
  label?: string;
}

interface HerdrLabels {
  herdrWorkspace: string;
  herdrTab: string;
}

function sessionValue(session: Session): string | undefined {
  return session.harness === 'pi' ? session.sessionFile : session.sessionId;
}

function sessionKey(session: Session): string {
  const identity = sessionValue(session) ?? `id:${session.sessionId}`;
  return `${session.harness}:${identity}`;
}

/** Companion-owned snapshot of Herdr state, including sessions confirmed absent from that snapshot. */
export class HerdrSessionCache {
  private labelsBySession = new Map<string, HerdrLabels>();
  private readonly checkedSessions = new Set<string>();
  private syncPromise?: Promise<void>;
  private readonly context: Pick<ActionContext, 'herdrPath' | 'run'>;

  constructor(context: Pick<ActionContext, 'herdrPath' | 'run'>) {
    this.context = context;
  }

  /** Refreshes Herdr once for a frontend connection and classifies every stored association. */
  async refresh(associations: Association[]): Promise<void> {
    this.checkedSessions.clear();
    await this.sync();
    for (const association of associations) this.checkedSessions.add(sessionKey(association));
  }

  /** Refreshes only when ingress introduces a session not classified by an earlier snapshot. */
  async ensure(session: Session): Promise<void> {
    const key = sessionKey(session);
    if (this.checkedSessions.has(key)) return;
    const value = sessionValue(session);
    if (value && this.labelsBySession.has(value)) {
      this.checkedSessions.add(key);
      return;
    }
    await this.sync();
    this.checkedSessions.add(key);
  }

  present(associations: Association[]): Association[] {
    return associations.map((association) => {
      const { herdrWorkspace: _workspace, herdrTab: _tab, ...plain } = association;
      const value = sessionValue(association);
      const labels = value ? this.labelsBySession.get(value) : undefined;
      return labels ? { ...plain, ...labels } : plain;
    });
  }

  private async sync(): Promise<void> {
    if (!this.context.herdrPath) return;
    if (this.syncPromise) return this.syncPromise;

    this.syncPromise = this.load().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async load(): Promise<void> {
    try {
      const run = this.context.run ?? ((command, args) => exec(command, args));
      const path = this.context.herdrPath;
      if (!path) return;
      const [agentResult, tabResult, workspaceResult] = await Promise.all([
        run(path, ['agent', 'list']),
        run(path, ['tab', 'list']),
        run(path, ['workspace', 'list']),
      ]);
      const agents = (JSON.parse(agentResult.stdout).result?.agents ?? []) as HerdrAgent[];
      const tabs = (JSON.parse(tabResult.stdout).result?.tabs ?? []) as HerdrTab[];
      const workspaces = (JSON.parse(workspaceResult.stdout).result?.workspaces ??
        []) as HerdrWorkspace[];
      const tabLabels = new Map(tabs.map((tab) => [tab.tab_id, tab.label]));
      const workspaceLabels = new Map(
        workspaces.map((workspace) => [workspace.workspace_id, workspace.label]),
      );
      const labelsBySession = new Map<string, HerdrLabels>();

      for (const agent of agents) {
        const value = agent.agent_session?.value;
        const herdrWorkspace = workspaceLabels.get(agent.workspace_id);
        const herdrTab = tabLabels.get(agent.tab_id);
        if (value && herdrWorkspace && herdrTab) {
          labelsBySession.set(value, { herdrWorkspace, herdrTab });
        }
      }
      this.labelsBySession = labelsBySession;
    } catch (error) {
      this.labelsBySession.clear();
      debug('herdr state sync failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
