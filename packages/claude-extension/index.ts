import { readFile } from 'node:fs/promises';
import type { AssociationStatus } from '@mdello/common/associations';
import type { HarnessAdapter, HarnessHookEvent } from '@mdello/common/harness';
import { extractMarkdownPaths } from '@mdello/common/paths';
import { modificationPath, parseTranscript, transcriptPaths } from './transcript.ts';

export const HARNESS = 'claude';

/** Path the companion serves for this harness; also the marker that identifies our hooks. */
export const HOOK_PATH = `/hooks/${HARNESS}`;

/** Official Claude Code hook inventory. Keep this list synchronized with Anthropic's hook docs. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'Setup',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'MessageDisplay',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Elicitation',
  'ElicitationResult',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

const CLAUDE_HOOK_EVENT_SET: ReadonlySet<string> = new Set(CLAUDE_HOOK_EVENTS);

function isClaudeHookEvent(event: string): event is ClaudeHookEvent {
  return CLAUDE_HOOK_EVENT_SET.has(event);
}

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  source?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  notification_type?: unknown;
  elicitation_id?: unknown;
  request_id?: unknown;
  agent_id?: unknown;
}

type SessionPhase = 'idle' | 'running' | 'ready_for_review' | 'closed';
type BlockerKind = 'question' | 'permission' | 'elicitation' | 'agent' | 'quota';

interface SessionLifecycle {
  phase: SessionPhase;
  blockers: Set<string>;
}

function blockerIdentity(payload: HookPayload): string | undefined {
  return (
    text(payload.tool_use_id) ??
    text(payload.elicitation_id) ??
    text(payload.request_id) ??
    text(payload.agent_id)
  );
}

function blockerKey(kind: BlockerKind, payload: HookPayload): string {
  return `${kind}:${blockerIdentity(payload) ?? 'unknown'}`;
}

function addBlocker(state: SessionLifecycle, kind: BlockerKind, payload: HookPayload): void {
  // Delayed notifications often omit the id carried by the direct lifecycle hook. Do not create
  // a second blocker that the eventual result cannot identify and clear.
  if (!blockerIdentity(payload) && [...state.blockers].some((key) => key.startsWith(`${kind}:`))) {
    return;
  }
  state.blockers.add(blockerKey(kind, payload));
}

function clearBlocker(state: SessionLifecycle, kind: BlockerKind, payload: HookPayload): void {
  const identity = blockerIdentity(payload);
  if (identity) state.blockers.delete(`${kind}:${identity}`);
  // Fallback notifications do not always carry an id. Matching lifecycle results are the only
  // available reconciliation signal for those anonymous blockers.
  state.blockers.delete(`${kind}:unknown`);
}

function clearToolBlockers(state: SessionLifecycle, payload: HookPayload): void {
  clearBlocker(state, 'question', payload);
  clearBlocker(state, 'permission', payload);
}

function statusOf(state: SessionLifecycle): AssociationStatus {
  if (state.phase === 'closed') return 'closed';
  if (state.blockers.size > 0) return 'waiting_for_input';
  return state.phase;
}

function activate(state: SessionLifecycle): void {
  state.phase = 'running';
}

function settle(state: SessionLifecycle, phase: 'ready_for_review' | 'closed'): void {
  state.phase = phase;
  state.blockers.clear();
}

function applyNotification(state: SessionLifecycle, hook: HookPayload): boolean {
  const notification = text(hook.notification_type);
  if (notification === 'permission_prompt') {
    activate(state);
    addBlocker(state, 'permission', hook);
  } else if (notification === 'agent_needs_input') {
    addBlocker(state, 'agent', hook);
  } else if (notification === 'elicitation_dialog' || notification === 'elicitation_url_dialog') {
    activate(state);
    addBlocker(state, 'elicitation', hook);
  } else if (notification === 'elicitation_complete' || notification === 'elicitation_response') {
    activate(state);
    clearBlocker(state, 'elicitation', hook);
  } else if (notification === 'quota_auto_resume_fired') {
    activate(state);
    clearBlocker(state, 'quota', hook);
  } else if (notification === 'quota_auto_resume_stale') {
    addBlocker(state, 'quota', hook);
  } else if (notification === 'quota_auto_resume_disabled') {
    state.phase = 'ready_for_review';
    clearBlocker(state, 'quota', hook);
  } else {
    return false;
  }
  return true;
}

type HookTransition = (
  current: SessionLifecycle | undefined,
  hook: HookPayload,
) => SessionLifecycle | undefined;

type StateUpdate = (state: SessionLifecycle, hook: HookPayload) => unknown;

function transitionOpen(update: StateUpdate): HookTransition {
  return (current, hook) => {
    const state = current ?? { phase: 'idle', blockers: new Set() };
    if (state.phase === 'closed' || update(state, hook) === false) return undefined;
    return state;
  };
}

const startSession: HookTransition = (current, hook) => {
  if (hook.source === 'compact') return current;
  return { phase: 'idle', blockers: new Set() };
};

const submitPrompt = transitionOpen((state) => {
  activate(state);
  state.blockers.clear();
});

const startQuestion = transitionOpen((state, hook) => {
  if (hook.tool_name !== 'AskUserQuestion') return false;
  activate(state);
  addBlocker(state, 'question', hook);
});

const startPermission = transitionOpen((state, hook) => {
  activate(state);
  addBlocker(state, 'permission', hook);
});

const denyPermission = transitionOpen((state, hook) => {
  activate(state);
  clearBlocker(state, 'permission', hook);
});

const finishTool = transitionOpen((state, hook) => {
  activate(state);
  clearToolBlockers(state, hook);
});

const startElicitation = transitionOpen((state, hook) => {
  activate(state);
  addBlocker(state, 'elicitation', hook);
});

const finishElicitation = transitionOpen((state, hook) => {
  activate(state);
  clearBlocker(state, 'elicitation', hook);
});

const notify = transitionOpen((state, hook) => applyNotification(state, hook));
const stop = transitionOpen((state) => settle(state, 'ready_for_review'));
const endSession = transitionOpen((state) => settle(state, 'closed'));

export interface ClaudeLifecycleHookPolicy {
  kind: 'lifecycle';
  transport: 'http' | 'command';
  matcher?: string;
  transition: HookTransition;
}

export interface ClaudeMetadataHookPolicy {
  kind: 'metadata';
}

export type ClaudeHookPolicy = ClaudeLifecycleHookPolicy | ClaudeMetadataHookPolicy;

const NOTIFICATION_MATCHER =
  'permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog|elicitation_complete|elicitation_response|quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled';

/**
 * Exhaustive lifecycle decision for every official event. TypeScript fails when inventory grows
 * without a matching policy, or when a policy names an event absent from inventory.
 */
export const CLAUDE_HOOK_POLICIES = {
  SessionStart: { kind: 'lifecycle', transport: 'command', transition: startSession },
  Setup: { kind: 'metadata' },
  UserPromptSubmit: { kind: 'lifecycle', transport: 'http', transition: submitPrompt },
  UserPromptExpansion: { kind: 'metadata' },
  MessageDisplay: { kind: 'metadata' },
  Stop: { kind: 'lifecycle', transport: 'http', transition: stop },
  StopFailure: { kind: 'lifecycle', transport: 'http', transition: stop },
  SessionEnd: { kind: 'lifecycle', transport: 'command', transition: endSession },
  PreToolUse: {
    kind: 'lifecycle',
    transport: 'http',
    matcher: 'AskUserQuestion',
    transition: startQuestion,
  },
  PermissionRequest: { kind: 'lifecycle', transport: 'http', transition: startPermission },
  PermissionDenied: { kind: 'lifecycle', transport: 'http', transition: denyPermission },
  PostToolUse: { kind: 'lifecycle', transport: 'http', transition: finishTool },
  PostToolUseFailure: { kind: 'lifecycle', transport: 'http', transition: finishTool },
  PostToolBatch: { kind: 'metadata' },
  Elicitation: { kind: 'lifecycle', transport: 'http', transition: startElicitation },
  ElicitationResult: { kind: 'lifecycle', transport: 'http', transition: finishElicitation },
  Notification: {
    kind: 'lifecycle',
    transport: 'http',
    matcher: NOTIFICATION_MATCHER,
    transition: notify,
  },
  SubagentStart: { kind: 'metadata' },
  SubagentStop: { kind: 'metadata' },
  TaskCreated: { kind: 'metadata' },
  TaskCompleted: { kind: 'metadata' },
  TeammateIdle: { kind: 'metadata' },
  PreCompact: { kind: 'metadata' },
  PostCompact: { kind: 'metadata' },
  PreModelSwitch: { kind: 'metadata' },
  PostModelSwitch: { kind: 'metadata' },
  InstructionsLoaded: { kind: 'metadata' },
  ConfigChange: { kind: 'metadata' },
  CwdChanged: { kind: 'metadata' },
  DirectoryAdded: { kind: 'metadata' },
  FileChanged: { kind: 'metadata' },
  WorktreeCreate: { kind: 'metadata' },
  WorktreeRemove: { kind: 'metadata' },
} satisfies Record<ClaudeHookEvent, ClaudeHookPolicy>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

async function transcriptCardPaths(payload: HookPayload): Promise<string[]> {
  const transcript = text(payload.transcript_path);
  if (!transcript) return [];
  try {
    return transcriptPaths(parseTranscript(await readFile(transcript, 'utf8')), text(payload.cwd));
  } catch {
    // A fresh session has no transcript yet.
    return [];
  }
}

/**
 * Cards an event reveals. Tool results without a card still matter when they resolve a blocker;
 * unchanged status-only results are filtered after lifecycle aggregation.
 */
async function discoverCardPaths(
  event: ClaudeHookEvent,
  payload: HookPayload,
): Promise<string[] | undefined> {
  if (event === 'SessionStart') return transcriptCardPaths(payload);
  if (event === 'UserPromptSubmit') return extractMarkdownPaths(text(payload.prompt) ?? '');
  if (event === 'PostToolUse') {
    const path = modificationPath(payload.tool_name, payload.tool_input, text(payload.cwd));
    return path ? [path] : [];
  }
  return [];
}

interface SessionTransition {
  state: SessionLifecycle;
  previousStatus: AssociationStatus;
}

function transitionSession(
  event: ClaudeHookEvent,
  hook: HookPayload,
  current: SessionLifecycle | undefined,
): SessionTransition | undefined {
  const policy: ClaudeHookPolicy = CLAUDE_HOOK_POLICIES[event];
  if (policy.kind !== 'lifecycle') return undefined;

  const previousStatus = statusOf(
    current ?? { phase: 'idle' as const, blockers: new Set<string>() },
  );
  const state = policy.transition(current, hook);
  return state ? { state, previousStatus } : undefined;
}

function isUnchangedToolResult(
  event: ClaudeHookEvent,
  cardPaths: string[],
  status: AssociationStatus,
  previousStatus: AssociationStatus,
): boolean {
  return (
    (event === 'PostToolUse' || event === 'PostToolUseFailure') &&
    cardPaths.length === 0 &&
    status === previousStatus
  );
}

/**
 * Claude emits hooks independently, but status is session-wide. Keep outstanding human blockers
 * separate so one result from a parallel tool batch cannot clear an unrelated question.
 */
export function createClaudeAdapter(): HarnessAdapter {
  const sessions = new Map<string, SessionLifecycle>();

  return {
    harness: HARNESS,
    async translate(payload: unknown): Promise<HarnessHookEvent | undefined> {
      if (!payload || typeof payload !== 'object') return undefined;
      const hook = payload as HookPayload;
      const event = text(hook.hook_event_name);
      const sessionId = text(hook.session_id);
      if (!event || !isClaudeHookEvent(event) || !sessionId) return undefined;

      const transition = transitionSession(event, hook, sessions.get(sessionId));
      if (!transition) return undefined;
      const { state, previousStatus } = transition;
      sessions.set(sessionId, state);

      const cardPaths = await discoverCardPaths(event, hook);
      if (!cardPaths) return undefined;
      const status = statusOf(state);
      if (isUnchangedToolResult(event, cardPaths, status, previousStatus)) return undefined;
      return { sessionId, sessionFile: text(hook.transcript_path), status, cardPaths };
    },
  };
}

export const claudeAdapter = createClaudeAdapter();

export interface ClaudeHook {
  type: 'http' | 'command';
  url?: string;
  command?: string;
  timeout: number;
}

export interface ClaudeHookEntry {
  matcher?: string;
  hooks: ClaudeHook[];
}

/**
 * Claude Code refuses `http` hooks on SessionStart, so command-transport policies post with curl.
 * `|| true` keeps a stopped companion quiet when SessionEnd hook failures reach stderr.
 */
export function claudeHookSettings(
  endpoint: string,
): Partial<Record<ClaudeHookEvent, ClaudeHookEntry[]>> {
  const url = `${endpoint.replace(/\/$/, '')}${HOOK_PATH}`;
  const entries: Partial<Record<ClaudeHookEvent, ClaudeHookEntry[]>> = {};

  for (const event of CLAUDE_HOOK_EVENTS) {
    const policy: ClaudeHookPolicy = CLAUDE_HOOK_POLICIES[event];
    if (policy.kind !== 'lifecycle') continue;

    const hook: ClaudeHook =
      policy.transport === 'http'
        ? { type: 'http', url, timeout: 2 }
        : {
            type: 'command',
            command: `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- ${url} > /dev/null 2>&1 || true`,
            timeout: 5,
          };
    entries[event] = [{ ...(policy.matcher ? { matcher: policy.matcher } : {}), hooks: [hook] }];
  }
  return entries;
}

export const PLUGIN_NAME = 'mdello-companion';

/** Marks a plugin directory as ours, so uninstall never deletes someone else's plugin. */
export const PLUGIN_MARKER = 'mdello-companion';

/**
 * Files of a Claude Code plugin that carries nothing but these hooks. Dropping this directory into
 * a skills directory loads it as `<name>@skills-dir` on the next session, so the integration
 * installs and uninstalls as one self-contained directory and never edits the user's settings.
 */
export function claudePluginFiles(endpoint: string): Record<string, string> {
  const manifest = {
    name: PLUGIN_NAME,
    description: 'Publishes Claude Code session status to the mdello companion.',
    metadata: { managedBy: PLUGIN_MARKER },
  };
  return {
    '.claude-plugin/plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'hooks/hooks.json': `${JSON.stringify({ hooks: claudeHookSettings(endpoint) }, null, 2)}\n`,
  };
}

/** True when a parsed `plugin.json` describes a directory this installer owns. */
export function isCompanionPlugin(manifest: unknown): boolean {
  const metadata = (manifest as { metadata?: { managedBy?: unknown } } | null)?.metadata;
  return metadata?.managedBy === PLUGIN_MARKER;
}
