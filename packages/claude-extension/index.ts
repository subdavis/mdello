import { readFile } from 'node:fs/promises';
import type { Association, AssociationStatus } from '@mdello/common/associations';
import { extractMarkdownPaths } from '@mdello/common/paths';
import { modificationPath, parseTranscript, transcriptPaths } from './transcript.ts';

const DEFAULT_URL = 'http://127.0.0.1:31337';
const HARNESS = 'claude';
const TIMEOUT_MS = 1000;

interface HookInput {
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

async function readHookInput(): Promise<HookInput | undefined> {
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) body += chunk;
  try {
    return JSON.parse(body) as HookInput;
  } catch {
    return undefined;
  }
}

async function sendAssociation(
  endpoint: string,
  cardPath: string,
  status: AssociationStatus,
  input: HookInput,
): Promise<void> {
  try {
    await fetch(`${endpoint}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdownPath: cardPath,
        harness: HARNESS,
        sessionId: input.session_id,
        sessionFile: text(input.transcript_path),
        status,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Companion is optional; Claude Code work must continue when it is not running.
  }
}

/**
 * Every hook runs in a fresh process, so the companion holds this session's card list rather than
 * the extension. Ask it which cards the session already touched before publishing a status change.
 */
async function sessionCardPaths(endpoint: string, sessionId: string): Promise<string[]> {
  try {
    const response = await fetch(`${endpoint}/associations`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const associations = (await response.json()) as Association[];
    return associations
      .filter(
        (association) => association.harness === HARNESS && association.sessionId === sessionId,
      )
      .map((association) => association.cardPath);
  } catch {
    return [];
  }
}

async function transcriptCardPaths(input: HookInput): Promise<string[]> {
  const transcript = text(input.transcript_path);
  if (!transcript) return [];
  try {
    return transcriptPaths(parseTranscript(await readFile(transcript, 'utf8')), text(input.cwd));
  } catch {
    // A new session has no transcript yet.
    return [];
  }
}

/**
 * Cards this event reveals. `undefined` means the event carries nothing relevant, so the hook
 * skips the companion entirely instead of republishing a status.
 */
async function discoverCardPaths(event: string, input: HookInput): Promise<string[] | undefined> {
  if (event === 'SessionStart') return transcriptCardPaths(input);
  if (event === 'UserPromptSubmit') return extractMarkdownPaths(text(input.prompt) ?? '');
  if (event === 'PostToolUse') {
    const path = modificationPath(input.tool_name, input.tool_input, text(input.cwd));
    return path ? [path] : undefined;
  }
  return [];
}

async function main(): Promise<void> {
  const input = await readHookInput();
  const event = text(input?.hook_event_name);
  const sessionId = text(input?.session_id);
  const status = event ? EVENT_STATUSES[event] : undefined;
  if (!input || !event || !sessionId || !status) return;

  const discovered = await discoverCardPaths(event, input);
  if (!discovered) return;

  const endpoint = (process.env.MDELLO_COMPANION_URL ?? DEFAULT_URL).replace(/\/$/, '');
  const cardPaths = new Set([...discovered, ...(await sessionCardPaths(endpoint, sessionId))]);
  await Promise.all(
    [...cardPaths].map((cardPath) => sendAssociation(endpoint, cardPath, status, input)),
  );
}

// Never write to stdout: Claude Code feeds hook stdout back as context on SessionStart and
// UserPromptSubmit. Never fail either, so a companion problem can never block a session.
try {
  await main();
} catch {
  process.exitCode = 0;
}
