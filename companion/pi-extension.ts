import { resolve } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import {
  extractMarkdownPaths,
  isModificationToolName,
  messageText,
  successfulModificationPaths,
} from './paths.ts';

const DEFAULT_URL = 'http://127.0.0.1:31337';

type Status = 'idle' | 'running' | 'waiting_for_input' | 'ready_for_review' | 'closed';

async function sendAssociation(
  endpoint: string,
  markdownPath: string,
  status: Status,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    await fetch(`${endpoint}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdownPath,
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
  const associatedCards = new Set<string>();
  let currentStatus: Status = 'idle';

  async function updateStatus(status: Status, ctx: ExtensionContext): Promise<void> {
    currentStatus = status;
    await Promise.all(
      [...associatedCards].map((cardPath) => sendAssociation(endpoint, cardPath, status, ctx)),
    );
  }

  async function associatePaths(paths: string[], ctx: ExtensionContext): Promise<void> {
    await Promise.all(
      paths.map(async (cardPath) => {
        associatedCards.add(cardPath);
        await sendAssociation(endpoint, cardPath, currentStatus, ctx);
      }),
    );
  }

  async function associate(text: string, ctx: ExtensionContext): Promise<void> {
    await associatePaths(extractMarkdownPaths(text), ctx);
  }

  pi.on('session_start', async (_event, ctx) => {
    currentStatus = 'idle';
    const messageEntries = ctx.sessionManager
      .getBranch()
      .filter((entry): entry is SessionMessageEntry => entry.type === 'message');
    await Promise.all([
      associate(
        messageEntries
          .filter((entry) => entry.message.role === 'user')
          .map((entry) => messageText(entry.message.content))
          .join('\n'),
        ctx,
      ),
      associatePaths(
        successfulModificationPaths(
          messageEntries.map((entry) => entry.message),
          ctx.cwd,
        ),
        ctx,
      ),
    ]);
  });

  pi.on('input', async (event, ctx) => {
    await associate(event.text, ctx);
    return { action: 'continue' };
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!isModificationToolName(event.toolName) || event.isError) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== 'string' || !input.path.toLowerCase().endsWith('.md')) return;
    await associatePaths([resolve(ctx.cwd, input.path)], ctx);
  });

  pi.on('agent_start', async (_event, ctx) => updateStatus('running', ctx));
  pi.on('ui_prompt_start', async (_event, ctx) => updateStatus('waiting_for_input', ctx));
  pi.on('ui_prompt_end', async (_event, ctx) =>
    updateStatus(ctx.isIdle() ? 'idle' : 'running', ctx),
  );
  pi.on('agent_settled', async (_event, ctx) => updateStatus('ready_for_review', ctx));
  pi.on('session_shutdown', async (_event, ctx) => updateStatus('closed', ctx));
}
