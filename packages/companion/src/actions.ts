import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Terminal } from './boards.ts';
import { createDebugLogger } from './debug.ts';

const exec = promisify(execFile);
const debug = createDebugLogger();

export type ActionName = 'focus';

export interface FocusRequest {
  action: 'focus';
  harness: string;
  sessionId: string;
  sessionFile?: string;
  hcTerminal?: string;
}

export type ActionRequest = FocusRequest;

export type ActionOutcome = { ok: true } | { ok: false; error: string };

interface CommandResult {
  stdout: string;
}

export interface ActionContext {
  /** The configured terminal that focuses sessions; absent when none is usable. */
  focusTerminal?: Terminal;
  /** Herdr executable path from configuration or active PATH discovery. */
  herdrPath?: string;
  /** herdr-core (`hc`) executable; enrichment reads terminal placement from it. */
  herdrCorePath?: string;
  /** Herdr Desktop CLI (`herdr-app`); focuses herdr-core terminals in the window. */
  herdrAppPath?: string;
  /** Injectable for tests; defaults to actually spawning the process. */
  run?: (command: string, args: string[]) => Promise<CommandResult>;
}

interface HerdrAgent {
  agent_session?: { value?: string };
  pane_id?: string;
  tab_id?: string;
}

function isActionRequest(value: unknown): value is ActionRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FocusRequest>;
  if (candidate.action === 'focus') {
    return (
      typeof candidate.harness === 'string' &&
      candidate.harness.length > 0 &&
      typeof candidate.sessionId === 'string' &&
      candidate.sessionId.length > 0 &&
      (candidate.sessionFile === undefined || typeof candidate.sessionFile === 'string') &&
      (candidate.hcTerminal === undefined || typeof candidate.hcTerminal === 'string')
    );
  }
  return false;
}

function resolveRun(context: ActionContext): NonNullable<ActionContext['run']> {
  return context.run ?? ((command, args) => exec(command, args));
}

/** `pi` sessions key on their transcript path; every other harness keys on the session id. */
function matchesSession(
  agent: HerdrAgent,
  session: Pick<FocusRequest, 'harness' | 'sessionId' | 'sessionFile'>,
): boolean {
  const value = agent.agent_session?.value;
  if (!value) return false;
  return value === (session.harness === 'pi' ? session.sessionFile : session.sessionId);
}

async function focusHerdr(
  request: FocusRequest,
  herdrPath: string,
  run: NonNullable<ActionContext['run']>,
): Promise<ActionOutcome> {
  const { stdout } = await run(herdrPath, ['agent', 'list']);
  const agents = (JSON.parse(stdout).result?.agents ?? []) as HerdrAgent[];
  const agent = agents.find((candidate) => matchesSession(candidate, request));
  if (!agent?.pane_id) return { ok: false, error: 'session_not_found' };

  await run(herdrPath, ['agent', 'focus', agent.pane_id]);
  // Herdr 0.9's per-client views do not project `agent focus` navigation to attached clients.
  // Focusing the resolved tab does, while the preceding command selects the exact split pane.
  if (agent.tab_id) await run(herdrPath, ['tab', 'focus', agent.tab_id]);
  return { ok: true };
}

/** Only the configured terminal: falling back could focus a stale pane in another app. */
async function focus(request: ActionRequest, context: ActionContext): Promise<ActionOutcome> {
  if (request.action !== 'focus') return { ok: false, error: 'invalid_action' };
  const { focusTerminal, herdrPath, herdrAppPath } = context;
  const run = resolveRun(context);

  if (focusTerminal === 'herdr' && herdrPath) return focusHerdr(request, herdrPath, run);
  if (focusTerminal === 'herdr-core' && herdrAppPath) {
    if (!request.hcTerminal) return { ok: false, error: 'session_not_found' };
    // herdr-app exits non-zero with `{ "error": ... }`, which surfaces as herdr_command_failed.
    await run(herdrAppPath, ['do', 'agent.focus', '--terminal', request.hcTerminal]);
    return { ok: true };
  }
  return { ok: false, error: 'herdr_not_configured' };
}

const ACTIONS: Record<
  ActionName,
  (request: ActionRequest, context: ActionContext) => Promise<ActionOutcome>
> = { focus };

export async function performAction(
  input: unknown,
  context: ActionContext,
): Promise<ActionOutcome | 'invalid'> {
  if (!isActionRequest(input)) return 'invalid';
  try {
    return await ACTIONS[input.action](input, context);
  } catch (error) {
    debug('action failed', {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: 'herdr_command_failed' };
  }
}
