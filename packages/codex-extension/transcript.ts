import type { HarnessSessionScan } from '@mdello/common/backfill';
import { extractMarkdownPaths, markdownToolPath } from '@mdello/common/paths';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function successful(value: unknown, patch: boolean): boolean {
  if (typeof value === 'string') {
    try {
      return successful(JSON.parse(value), patch);
    } catch {
      // Native tool results can be plain text rather than serialized JSON.
      return patch
        ? /^Success\. Updated the following files:/m.test(value)
        : /^(?:ok|success)(?:\b|\.)/i.test(value.trim());
    }
  }
  const result = record(value);
  if (!result) return false;
  if (
    result.is_error === true ||
    result.isError === true ||
    result.success === false ||
    (typeof result.exit_code === 'number' && result.exit_code !== 0)
  )
    return false;
  if (result.output !== undefined) return successful(result.output, patch);
  return result.success === true || result.is_error === false || result.isError === false;
}

/** Only explicit edit/write tool names; never infer a card from a read or arbitrary shell output. */
export function modificationPaths(
  name: unknown,
  input: unknown,
  response: unknown,
  cwd?: string,
): string[] {
  const args = record(input);
  if (typeof name !== 'string') return [];
  if (!successful(response, name === 'apply_patch')) return [];
  if (name === 'apply_patch') {
    const patch = args?.command ?? args?.patch;
    if (typeof patch !== 'string') return [];
    const paths = [
      ...patch.matchAll(
        /^\*\*\* (?:Update|Add) File: (.+)\r?$(?:\r?\n\*\*\* Move to: (.+)\r?$)?/gm,
      ),
    ]
      .map((match) => markdownToolPath((match[2] ?? match[1]).trim(), cwd))
      .filter((path): path is string => Boolean(path));
    return [...new Set(paths)];
  }
  if (!/(?:^|[._])(?:edit|write|MultiEdit|Edit|Write)$/.test(name)) return [];
  const path = markdownToolPath(args?.path ?? args?.file_path, cwd);
  return path ? [path] : [];
}

function userText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => {
      const item = record(part);
      return item?.type === 'input_text' && typeof item.text === 'string' ? [item.text] : [];
    })
    .join('\n');
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function callArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { command: value };
  }
}

interface ModificationCall {
  name: unknown;
  input: unknown;
  cwd?: string;
}

function collectResponse(
  payload: Record<string, unknown> | undefined,
  cwd: string | undefined,
  paths: Set<string>,
  calls: Map<string, ModificationCall>,
  scan: HarnessSessionScan,
): void {
  if (payload?.type === 'message' && payload.role === 'user') {
    for (const path of extractMarkdownPaths(userText(payload.content))) paths.add(path);
  }
  if (typeof payload?.call_id !== 'string') return;
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const args = callArguments(payload.arguments ?? payload.input);
    // Code-mode rollouts store JavaScript, not the individual nested tool calls.
    if (payload.name === 'exec' || payload.name === 'functions.exec') scan.incomplete = true;
    calls.set(payload.call_id, { name: payload.name, input: args, cwd });
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const call = calls.get(payload.call_id);
    if (call) {
      for (const path of modificationPaths(call.name, call.input, payload.output, call.cwd)) {
        paths.add(path);
      }
    }
    calls.delete(payload.call_id);
  }
}

/** Codex rollout JSONL stores calls by call_id, followed by their outputs. */
export function scanTranscript(contents: string): HarnessSessionScan {
  const scan: HarnessSessionScan = { cardPaths: [] };
  const paths = new Set<string>();
  const calls = new Map<string, ModificationCall>();
  let cwd: string | undefined;
  for (const line of contents.split('\n')) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (
      typeof entry.timestamp === 'string' &&
      (!scan.updatedAt || entry.timestamp > scan.updatedAt)
    ) {
      scan.updatedAt = entry.timestamp;
    }
    const payload = record(entry.payload);
    if (entry.type === 'session_meta' && typeof payload?.id === 'string')
      scan.sessionId ??= payload.id;
    if (
      (entry.type === 'session_meta' || entry.type === 'turn_context') &&
      typeof payload?.cwd === 'string'
    )
      cwd = payload.cwd;
    if (entry.type === 'response_item') collectResponse(payload, cwd, paths, calls, scan);
  }
  scan.cardPaths = [...paths];
  return scan;
}
