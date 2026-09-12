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
  { event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write' },
  { event: 'Notification', matcher: 'permission_prompt|idle_prompt|agent_needs_input' },
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

/** Recognizes hooks this integration owns, across companion ports and past install layouts. */
export function isCompanionHook(value: unknown): boolean {
  const hook = value as { url?: unknown; command?: unknown } | null;
  const fields = [hook?.url, hook?.command];
  return fields.some(
    (field) =>
      typeof field === 'string' &&
      (field.includes(HOOK_PATH) || field.includes('mdello-companion')),
  );
}
