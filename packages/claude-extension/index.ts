import { readFile } from 'node:fs/promises';
import type { AssociationStatus } from '@mdello/common/associations';
import type { HarnessAdapter, HarnessHookEvent } from '@mdello/common/harness';
import { extractMarkdownPaths } from '@mdello/common/paths';
import { modificationPath, parseTranscript, transcriptPaths } from './transcript.ts';

export const HARNESS = 'claude';

/** Path the companion serves for this harness; also the marker that identifies our hooks. */
export const HOOK_PATH = `/hooks/${HARNESS}`;

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

/** Claude Code lifecycle events mapped to the closest companion status. */
const EVENT_STATUSES: Record<string, AssociationStatus> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'running',
  PostToolUse: 'running',
  Notification: 'waiting_for_input',
  Stop: 'ready_for_review',
  SessionEnd: 'closed',
};

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
 * Cards an event reveals. `undefined` means the event is irrelevant, which keeps a tool call on a
 * non-Markdown file from republishing the session's status.
 */
async function discoverCardPaths(
  event: string,
  payload: HookPayload,
): Promise<string[] | undefined> {
  if (event === 'SessionStart') return transcriptCardPaths(payload);
  if (event === 'UserPromptSubmit') return extractMarkdownPaths(text(payload.prompt) ?? '');
  if (event === 'PostToolUse') {
    if (payload.tool_name === 'AskUserQuestion') return [];
    const path = modificationPath(payload.tool_name, payload.tool_input, text(payload.cwd));
    return path ? [path] : undefined;
  }
  return [];
}

export const claudeAdapter: HarnessAdapter = {
  harness: HARNESS,
  async translate(payload: unknown): Promise<HarnessHookEvent | undefined> {
    if (!payload || typeof payload !== 'object') return undefined;
    const hook = payload as HookPayload;
    const event = text(hook.hook_event_name);
    const sessionId = text(hook.session_id);
    const status = event ? EVENT_STATUSES[event] : undefined;
    if (!event || !sessionId || !status) return undefined;

    const cardPaths = await discoverCardPaths(event, hook);
    if (!cardPaths) return undefined;

    return { sessionId, sessionFile: text(hook.transcript_path), status, cardPaths };
  },
};

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
 * Claude Code refuses `http` hooks on SessionStart, so those two per-session events post with
 * curl instead. `|| true` keeps a stopped companion quiet: SessionEnd is the one event whose hook
 * failures are written to stderr.
 */
const HTTP_EVENTS: { event: string; matcher?: string }[] = [
  { event: 'UserPromptSubmit' },
  // AskUserQuestion completes only after the user submits an answer, so its PostToolUse event
  // moves the session out of waiting_for_input.
  { event: 'PostToolUse', matcher: 'AskUserQuestion|Edit|MultiEdit|Write' },
  // Only notifications that genuinely block on the human. `idle_prompt` fires when a finished
  // session has merely been sitting there, so subscribing to it reported every idle session as
  // waiting_for_input and buried the ones actually asking a question.
  { event: 'Notification', matcher: 'permission_prompt|agent_needs_input' },
  { event: 'Stop' },
];
const COMMAND_EVENTS = ['SessionStart', 'SessionEnd'];

export function claudeHookSettings(endpoint: string): Record<string, ClaudeHookEntry[]> {
  const url = `${endpoint.replace(/\/$/, '')}${HOOK_PATH}`;
  const entries: Record<string, ClaudeHookEntry[]> = {};

  for (const { event, matcher } of HTTP_EVENTS) {
    entries[event] = [
      { ...(matcher ? { matcher } : {}), hooks: [{ type: 'http', url, timeout: 2 }] },
    ];
  }
  for (const event of COMMAND_EVENTS) {
    const command = `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- ${url} > /dev/null 2>&1 || true`;
    entries[event] = [{ hooks: [{ type: 'command', command, timeout: 5 }] }];
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
