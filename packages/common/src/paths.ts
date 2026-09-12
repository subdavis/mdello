import { resolve } from 'node:path';

export function extractMarkdownPaths(text: string): string[] {
  const matches = text.match(/(?<![\w.])(?:[A-Za-z]:[\\/]|\/)[^\n\r"'`]+?\.md\b/g) ?? [];
  return [...new Set(matches)];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export function isModificationToolName(value: unknown): value is 'edit' | 'write' {
  return value === 'edit' || value === 'write';
}

export function markdownToolPath(value: unknown, cwd?: string): string | undefined {
  if (typeof value !== 'string' || !value.toLowerCase().endsWith('.md')) return undefined;
  if (value.startsWith('/')) return value;
  return cwd ? resolve(cwd, value) : undefined;
}

function modificationCall(value: unknown, cwd?: string): { id: string; path: string } | undefined {
  const call = record(value);
  if (
    call?.type !== 'toolCall' ||
    !isModificationToolName(call.name) ||
    typeof call.id !== 'string'
  ) {
    return undefined;
  }
  const path = markdownToolPath(record(call.arguments)?.path, cwd);
  return path ? { id: call.id, path } : undefined;
}

function successfulModificationId(value: unknown): string | undefined {
  const message = record(value);
  return message?.role === 'toolResult' &&
    isModificationToolName(message.toolName) &&
    message.isError !== true &&
    typeof message.toolCallId === 'string'
    ? message.toolCallId
    : undefined;
}

export function successfulModificationPaths(messages: unknown[], cwd?: string): string[] {
  const calls = new Map<string, string>();
  for (const value of messages) {
    const message = record(value);
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = modificationCall(block, cwd);
      if (call) calls.set(call.id, call.path);
    }
  }

  const paths = new Set<string>();
  for (const value of messages) {
    const id = successfulModificationId(value);
    const path = id ? calls.get(id) : undefined;
    if (path) paths.add(path);
  }
  return [...paths];
}

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part
        ? [String(part.text)]
        : [],
    )
    .join('\n');
}
