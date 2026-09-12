import { extractMarkdownPaths, markdownToolPath, messageText } from '@mdello/common/paths';

const MODIFICATION_TOOLS = ['Edit', 'MultiEdit', 'Write'] as const;

export type ModificationToolName = (typeof MODIFICATION_TOOLS)[number];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export function isModificationToolName(value: unknown): value is ModificationToolName {
  return MODIFICATION_TOOLS.includes(value as ModificationToolName);
}

export function modificationPath(
  toolName: unknown,
  toolInput: unknown,
  cwd?: string,
): string | undefined {
  if (!isModificationToolName(toolName)) return undefined;
  return markdownToolPath(record(toolInput)?.file_path, cwd);
}

/**
 * Collect card paths from Claude Code transcript entries: absolute Markdown paths in user text,
 * plus Markdown files modified by a tool call that succeeded. A tool result always follows its
 * tool call, so one pass resolves both. Entries carry their own `cwd`, which stays correct when
 * Claude changes directory mid-session.
 */
export function transcriptPaths(entries: unknown[], cwd?: string): string[] {
  const paths = new Set<string>();
  const calls = new Map<string, string>();

  for (const value of entries) {
    const entry = record(value);
    const message = record(entry?.message);
    if (!message) continue;
    const entryCwd = typeof entry?.cwd === 'string' ? entry.cwd : cwd;

    if (message.role === 'user') {
      for (const path of extractMarkdownPaths(messageText(message.content))) paths.add(path);
    }
    if (!Array.isArray(message.content)) continue;

    for (const item of message.content) {
      const block = record(item);
      if (!block) continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const path = modificationPath(block.name, block.input, entryCwd);
        if (path) calls.set(block.id, path);
      }
      if (
        block.type === 'tool_result' &&
        block.is_error !== true &&
        typeof block.tool_use_id === 'string'
      ) {
        const path = calls.get(block.tool_use_id);
        if (path) paths.add(path);
      }
    }
  }

  return [...paths];
}

export function parseTranscript(contents: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // One damaged line should not hide associations elsewhere in the transcript.
    }
  }
  return entries;
}
