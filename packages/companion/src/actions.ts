import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDebugLogger } from './debug.ts';

const exec = promisify(execFile);
const debug = createDebugLogger();

export type ActionName = 'focus';

export interface FocusRequest {
  action: 'focus';
  harness: string;
  sessionId: string;
  sessionFile?: string;
}

export type ActionRequest = FocusRequest;

export type ActionOutcome = { ok: true } | { ok: false; error: string };

interface CommandResult {
  stdout: string;
}

export interface ActionContext {
  /** Bundle id of the terminal emulator herdr runs in, e.g. com.mitchellh.ghostty. */
  herdrBundleId?: string;
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
      (candidate.sessionFile === undefined || typeof candidate.sessionFile === 'string')
    );
  }
  return false;
}

function resolveRun(context: ActionContext): NonNullable<ActionContext['run']> {
  return context.run ?? ((command, args) => exec(command, args));
}

/** `pi` sessions key on their transcript path; every other harness keys on the session id. */
function matchesSession(agent: HerdrAgent, request: FocusRequest): boolean {
  const value = agent.agent_session?.value;
  if (!value) return false;
  return value === (request.harness === 'pi' ? request.sessionFile : request.sessionId);
}

async function focus(request: ActionRequest, context: ActionContext): Promise<ActionOutcome> {
  if (request.action !== 'focus') return { ok: false, error: 'invalid_action' };
  const bundleId = context.herdrBundleId;
  if (!bundleId) return { ok: false, error: 'herdr_not_configured' };

  const run = resolveRun(context);
  const { stdout } = await run('herdr', ['agent', 'list']);
  const agents = (JSON.parse(stdout).result?.agents ?? []) as HerdrAgent[];
  const agent = agents.find((candidate) => matchesSession(candidate, request));
  if (!agent?.pane_id) return { ok: false, error: 'session_not_found' };

  await run('herdr', ['agent', 'focus', agent.pane_id]);
  // Herdr 0.9's per-client views do not project `agent focus` navigation to attached clients.
  // Focusing the resolved tab does, while the preceding command selects the exact split pane.
  if (agent.tab_id) await run('herdr', ['tab', 'focus', agent.tab_id]);
  await run('open', ['-b', bundleId]);
  return { ok: true };
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
