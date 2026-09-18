import type { AssociationStatus } from '@mdello/common/associations';
import {
  extractMarkdownPaths,
  isModificationToolName,
  markdownToolPath,
} from '@mdello/common/paths';
import type { Hooks, Plugin } from '@opencode-ai/plugin';

const DEFAULT_URL = 'http://127.0.0.1:51618';

interface MessagePart {
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
  };
}

interface SessionMessage {
  info: { role: string };
  parts: MessagePart[];
}

export interface CompanionClient {
  session: {
    messages(options: {
      path: { id: string };
      query: { directory: string };
    }): Promise<{ data?: SessionMessage[] }>;
  };
}

interface SessionState {
  cards: Set<string>;
  status: AssociationStatus;
  restored?: Promise<void>;
}

export interface CompanionHooksOptions {
  client: CompanionClient;
  directory: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function sessionId(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.sessionID === 'string') return properties.sessionID;
  const info = record(properties.info);
  return typeof info?.id === 'string' ? info.id : undefined;
}

function userText(part: MessagePart): string | undefined {
  return part.type === 'text' && !part.synthetic && typeof part.text === 'string'
    ? part.text
    : undefined;
}

function completedModificationPath(part: MessagePart, directory: string): string | undefined {
  if (
    part.type !== 'tool' ||
    !isModificationToolName(part.tool) ||
    part.state?.status !== 'completed'
  ) {
    return undefined;
  }
  return markdownToolPath(part.state.input?.filePath, directory);
}

function messagePaths(message: SessionMessage, directory: string): string[] {
  const userPaths =
    message.info.role === 'user'
      ? message.parts.flatMap((part) => {
          const text = userText(part);
          return text ? extractMarkdownPaths(text) : [];
        })
      : [];
  const modificationPaths = message.parts.flatMap((part) => {
    const path = completedModificationPath(part, directory);
    return path ? [path] : [];
  });
  return [...userPaths, ...modificationPaths];
}

function restoredPaths(messages: SessionMessage[], directory: string): string[] {
  return [...new Set(messages.flatMap((message) => messagePaths(message, directory)))];
}

export function createCompanionHooks(options: CompanionHooksOptions): Hooks {
  const endpoint = (options.endpoint ?? process.env.MDELLO_COMPANION_URL ?? DEFAULT_URL).replace(
    /\/$/,
    '',
  );
  const request = options.fetch ?? globalThis.fetch;
  const sessions = new Map<string, SessionState>();

  function stateFor(id: string): SessionState {
    let state = sessions.get(id);
    if (!state) {
      state = { cards: new Set(), status: 'idle' };
      sessions.set(id, state);
    }
    return state;
  }

  async function send(id: string, path: string, status: AssociationStatus): Promise<void> {
    try {
      await request(`${endpoint}/associations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdownPath: path,
          harness: 'opencode',
          sessionId: id,
          status,
        }),
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      // Companion is optional; OpenCode work must continue when it is unavailable.
    }
  }

  async function associatePaths(id: string, paths: string[]): Promise<void> {
    const state = stateFor(id);
    await Promise.all(
      paths.map(async (path) => {
        if (state.cards.has(path)) return;
        state.cards.add(path);
        await send(id, path, state.status);
      }),
    );
  }

  async function restore(id: string): Promise<void> {
    const state = stateFor(id);
    if (!state.restored) {
      state.restored = (async () => {
        try {
          const response = await options.client.session.messages({
            path: { id },
            query: { directory: options.directory },
          });
          await associatePaths(id, restoredPaths(response.data ?? [], options.directory));
        } catch {
          // History restoration is best effort for the same reason as publishing.
        }
      })();
    }
    await state.restored;
  }

  async function updateStatus(id: string, status: AssociationStatus): Promise<void> {
    const state = stateFor(id);
    const cards = [...state.cards];
    const changed = state.status !== status;
    state.status = status;
    await restore(id);
    if (changed) await Promise.all(cards.map((path) => send(id, path, status)));
  }

  async function closeAll(): Promise<void> {
    await Promise.all([...sessions].map(([id]) => updateStatus(id, 'closed')));
  }

  return {
    'chat.message': async (input, output) => {
      await updateStatus(input.sessionID, 'running');
      const text = output.parts
        .filter((part) => part.type === 'text' && !part.synthetic)
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n');
      await associatePaths(input.sessionID, extractMarkdownPaths(text));
    },
    'tool.execute.before': async (input) => {
      if (input.tool === 'question') await updateStatus(input.sessionID, 'waiting_for_input');
    },
    'tool.execute.after': async (input) => {
      if (input.tool === 'question') {
        await updateStatus(input.sessionID, 'running');
        return;
      }
      if (!isModificationToolName(input.tool)) return;
      const path = markdownToolPath(record(input.args)?.filePath, options.directory);
      if (path) await associatePaths(input.sessionID, [path]);
    },
    event: async ({ event }) => {
      const runtimeEvent = event as unknown as { type: string; properties?: unknown };
      const properties = record(runtimeEvent.properties) ?? {};
      const id = sessionId(properties);

      switch (runtimeEvent.type) {
        case 'session.created':
          if (id) await updateStatus(id, 'idle');
          break;
        case 'session.status': {
          const type = record(properties.status)?.type;
          if (id && (type === 'busy' || type === 'retry')) await updateStatus(id, 'running');
          break;
        }
        case 'session.idle':
        case 'session.error':
          if (id) await updateStatus(id, 'ready_for_review');
          break;
        case 'permission.asked':
        case 'permission.updated':
        case 'question.asked':
          if (id) await updateStatus(id, 'waiting_for_input');
          break;
        case 'permission.replied':
        case 'question.replied':
        case 'question.rejected':
          if (id) await updateStatus(id, 'running');
          break;
        case 'session.deleted':
          if (id) {
            await updateStatus(id, 'closed');
            sessions.delete(id);
          }
          break;
        case 'server.instance.disposed':
          await closeAll();
          break;
      }
    },
    dispose: closeAll,
  };
}

export const MdelloCompanion = (async ({ client, directory }) =>
  createCompanionHooks({
    client: client as unknown as CompanionClient,
    directory,
  })) satisfies Plugin;

export default MdelloCompanion;
