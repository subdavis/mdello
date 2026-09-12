import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import { extractCardPaths, messageText } from './paths.ts';

const DEFAULT_URL = 'http://127.0.0.1:31337';
const DEFAULT_BOARD_ROOT = resolve(homedir(), 'Documents', 'mdello');

type Status = 'idle' | 'running' | 'waiting_for_input' | 'ready_for_review' | 'closed';

async function sendAssociation(
  endpoint: string,
  cardPath: string,
  status: Status,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    await fetch(`${endpoint}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardPath,
        harness: 'pi',
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        status,
      }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Companion is optional; Pi work must continue when it is not running.
  }
}

export default function mdelloCompanion(pi: ExtensionAPI): void {
  const endpoint = (process.env.MDELLO_COMPANION_URL ?? DEFAULT_URL).replace(/\/$/, '');
  const boardRoot = resolve(process.env.MDELLO_BOARD_PATH ?? DEFAULT_BOARD_ROOT);
  const associatedCards = new Set<string>();
  let currentStatus: Status = 'idle';

  async function updateStatus(status: Status, ctx: ExtensionContext): Promise<void> {
    currentStatus = status;
    await Promise.all(
      [...associatedCards].map((cardPath) => sendAssociation(endpoint, cardPath, status, ctx)),
    );
  }

  async function associate(text: string, ctx: ExtensionContext): Promise<void> {
    const paths = extractCardPaths(text, boardRoot);
    await Promise.all(
      paths.map(async (cardPath) => {
        associatedCards.add(cardPath);
        await sendAssociation(endpoint, cardPath, currentStatus, ctx);
      }),
    );
  }

  pi.on('session_start', async (_event, ctx) => {
    currentStatus = 'idle';
    const userEntries = ctx.sessionManager
      .getBranch()
      .filter(
        (entry): entry is SessionMessageEntry =>
          entry.type === 'message' && entry.message.role === 'user',
      );
    await associate(userEntries.map((entry) => messageText(entry.message.content)).join('\n'), ctx);
  });

  pi.on('input', async (event, ctx) => {
    await associate(event.text, ctx);
    return { action: 'continue' };
  });

  pi.on('agent_start', async (_event, ctx) => updateStatus('running', ctx));
  pi.on('ui_prompt_start', async (_event, ctx) => updateStatus('waiting_for_input', ctx));
  pi.on('ui_prompt_end', async (_event, ctx) =>
    updateStatus(ctx.isIdle() ? 'idle' : 'running', ctx),
  );
  pi.on('agent_settled', async (_event, ctx) => updateStatus('ready_for_review', ctx));
  pi.on('session_shutdown', async (_event, ctx) => updateStatus('closed', ctx));
}
