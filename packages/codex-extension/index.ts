import { readFile } from 'node:fs/promises';
import type { HarnessAdapter, HarnessHookEvent } from '@mdello/common/harness';
import { extractMarkdownPaths } from '@mdello/common/paths';
import { modificationPaths, scanTranscript } from './transcript.ts';

export const HARNESS = 'codex';
export const HOOK_PATH = `/hooks/${HARNESS}`;

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const;

type Event = (typeof EVENTS)[number];

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  source?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function status(event: Event): HarnessHookEvent['status'] {
  switch (event) {
    case 'SessionStart':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'running';
    case 'PermissionRequest':
      return 'waiting_for_input';
    case 'Stop':
    case 'Interrupt':
      return 'ready_for_review';
    case 'SessionEnd':
      return 'closed';
  }
}

export const codexAdapter: HarnessAdapter = {
  harness: HARNESS,
  async translate(value: unknown): Promise<HarnessHookEvent | undefined> {
    if (!value || typeof value !== 'object') return undefined;
    const hook = value as HookPayload;
    const event = text(hook.hook_event_name);
    const sessionId = text(hook.session_id);
    if (!sessionId || !event || !EVENTS.includes(event as Event)) return undefined;
    if (event === 'SessionStart' && hook.source === 'compact') return undefined;

    let cardPaths: string[] = [];
    if (event === 'SessionStart' && text(hook.transcript_path)) {
      try {
        cardPaths = scanTranscript(
          await readFile(hook.transcript_path as string, 'utf8'),
        ).cardPaths;
      } catch {
        // Transcript might not exist yet on a new session.
      }
    } else if (event === 'UserPromptSubmit') {
      cardPaths = extractMarkdownPaths(text(hook.prompt) ?? '');
    } else if (event === 'PostToolUse') {
      cardPaths = modificationPaths(
        hook.tool_name,
        hook.tool_input,
        hook.tool_response,
        text(hook.cwd),
      );
    }
    return {
      sessionId,
      sessionFile: text(hook.transcript_path),
      status: status(event as Event),
      cardPaths,
    };
  },
};

/** Unique command marker lets install/uninstall leave other hooks and user settings intact. */
export const HOOK_MARKER = 'mdello-codex-companion';

export function codexHookSettings(endpoint: string): Record<string, unknown[]> {
  const url = `${endpoint.replace(/\/$/, '')}${HOOK_PATH}`;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/hooks\/codex$/.test(url)) {
    throw new Error('Codex companion endpoint must be a loopback HTTP URL with a numeric port.');
  }
  const command = `curl --silent --max-time 2 --request POST --header 'Content-Type: application/json' --data-binary @- '${url}' > /dev/null 2>&1 || true # ${HOOK_MARKER}`;
  return Object.fromEntries(
    EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: event === 'SessionEnd' || event === 'Interrupt' ? 3 : 5,
            },
          ],
        },
      ],
    ]),
  );
}

export function isManagedHook(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const hook = value as { command?: unknown };
  return typeof hook.command === 'string' && hook.command.endsWith(`# ${HOOK_MARKER}`);
}
