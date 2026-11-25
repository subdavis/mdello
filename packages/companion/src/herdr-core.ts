import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Association } from '@mdello/common/associations';
import type { ActionContext } from './actions.ts';
import { createDebugLogger } from './debug.ts';

const debug = createDebugLogger();
const exec = promisify(execFile);

interface HcTerminal {
  address?: string;
  where?: string;
  /** Present only for agent terminals: `working`, `done`, `idle`, … */
  status?: string;
}

// Agents in a tab or workspace with these names coordinate other agents and never bind to cards.
const RESERVED_AGENT_NAMES = new Set(['orchestrator', 'control plane']);
export const isReservedName = (name: string | undefined) =>
  Boolean(name && RESERVED_AGENT_NAMES.has(name.trim().toLowerCase()));

export type OrchestratorStatus = 'running' | 'idle';
export interface Orchestrator {
  hcTerminal: string;
  status: OrchestratorStatus;
}

type Context = Pick<ActionContext, 'herdrCorePath' | 'run'> & {
  onOrchestrator?: (orchestrator: Orchestrator | undefined) => void;
};

/** Herdr Desktop shows `where` as `Space / Tab`; terminals without it are hidden workers. */
function parseWhere(where: string | undefined) {
  const separator = where?.indexOf(' / ') ?? -1;
  if (!where || separator < 0) return undefined;
  return { herdrWorkspace: where.slice(0, separator), herdrTab: where.slice(separator + 3) };
}

/**
 * herdr-core (`hc`) knows terminals, not agent sessions, so harnesses report `$HC_TERMINAL_ID`
 * as `hcTerminal` and this cache labels associations from `hc ls`.
 */
export class HerdrCoreSessionCache {
  private whereByTerminal = new Map<string, string>();
  private readonly checkedTerminals = new Set<string>();
  private syncPromise?: Promise<void>;
  private readonly context: Context;

  constructor(context: Context) {
    this.context = context;
  }

  orchestrator?: Orchestrator;

  /** Notifies only on change, so callers may report every status they hear. */
  setOrchestrator(next: Orchestrator | undefined): void {
    if (JSON.stringify(next) === JSON.stringify(this.orchestrator)) return;
    this.orchestrator = next;
    this.context.onOrchestrator?.(next);
  }

  async refresh(): Promise<void> {
    this.checkedTerminals.clear();
    await this.sync();
  }

  /** Syncs once per unseen terminal until the next frontend refresh. */
  async ensure({ hcTerminal }: Pick<Association, 'hcTerminal'>): Promise<void> {
    if (!hcTerminal || this.checkedTerminals.has(hcTerminal)) return;
    if (!this.whereByTerminal.has(hcTerminal)) await this.sync();
    this.checkedTerminals.add(hcTerminal);
  }

  /** Labels only associations an earlier terminal did not already label. */
  present(associations: Association[]): Association[] {
    return associations.map((association) => {
      // shortcut: a terminal can host later sessions; closed ones are skipped, a crashed
      // session that never reported closed may borrow labels. Track terminal owner if it bites.
      if (association.herdrWorkspace || !association.hcTerminal || association.status === 'closed')
        return association;
      const labels = parseWhere(this.whereByTerminal.get(association.hcTerminal));
      return labels ? { ...association, ...labels } : association;
    });
  }

  private async sync(): Promise<void> {
    if (!this.context.herdrCorePath) return;
    this.syncPromise ??= this.load().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  private async load(): Promise<void> {
    const path = this.context.herdrCorePath;
    if (!path) return;
    try {
      const run = this.context.run ?? ((command, args) => exec(command, args));
      const { stdout } = await run(path, ['ls', '--json']);
      const terminals = (JSON.parse(stdout).terminals ?? []) as HcTerminal[];
      this.whereByTerminal = new Map(
        terminals.flatMap((terminal) =>
          terminal.address && terminal.where ? [[terminal.address, terminal.where]] : [],
        ),
      );
      // Shells share the orchestrator's tab; only an agent terminal reports a status.
      const orchestrator = terminals.find((terminal) => {
        const labels = parseWhere(terminal.where);
        return (
          terminal.address &&
          terminal.status &&
          (isReservedName(labels?.herdrWorkspace) || isReservedName(labels?.herdrTab))
        );
      });
      this.setOrchestrator(
        orchestrator?.address
          ? {
              hcTerminal: orchestrator.address,
              status: orchestrator.status === 'working' ? 'running' : 'idle',
            }
          : undefined,
      );
    } catch (error) {
      this.whereByTerminal.clear();
      this.setOrchestrator(undefined);
      debug('herdr-core state sync failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
