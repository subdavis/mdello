# Agent extension contract

An agent extension connects one harness session to companion associations. Implementations may use different harness APIs, but must preserve this behavior.

## Required behavior

1. **Identify itself:** use a stable, non-empty `harness` name and harness-native stable `sessionId`; include `sessionFile` when available.
2. **Discover cards:** inspect user input for absolute `.md` paths. Also inspect successful Markdown `edit` and `write` calls, resolving relative paths against session working directory. Ignore reads and de-duplicate paths within the session.
3. **Publish:** `POST /associations` once when discovering a card and whenever session status changes:

```json
{
  "markdownPath": "/absolute/board/card.md",
  "harness": "pi",
  "sessionId": "stable-session-id",
  "sessionFile": "/optional/session.jsonl",
  "status": "running"
}
```

4. **Restore:** on session start/resume, scan available session history for prior user paths and successful edits/writes, then republish them with current status.
5. **Never block the agent:** companion is optional. Use a short timeout, swallow network failures, and do not change normal input/tool behavior.
6. **Track the session's cards:** a harness that keeps one long-lived process may hold them in memory. A harness that spawns a process per event must instead read them back from `GET /associations`, filtering on its own `harness` and `sessionId`.

## Status mapping

Map harness lifecycle events to the closest companion status:

| Status | Meaning |
| --- | --- |
| `idle` | Session open; agent not running |
| `running` | Agent processing |
| `waiting_for_input` | Agent blocked on an interactive user prompt |
| `ready_for_review` | Agent settled after completing work |
| `closed` | Session shutting down |

Publish status changes to every card associated with the session. Re-associating the same `(card, harness, sessionId)` updates it rather than creating another session.

### Per-harness events

| Status | Pi event | Claude Code hook |
| --- | --- | --- |
| `idle` | `session_start`, `ui_prompt_end` when idle | `SessionStart` |
| `running` | `agent_start`, `ui_prompt_end` when busy | `UserPromptSubmit`, `PostToolUse` |
| `waiting_for_input` | `ui_prompt_start` | `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`) |
| `ready_for_review` | `agent_settled` | `Stop` |
| `closed` | `session_shutdown` | `SessionEnd` |

Claude Code has no separate "agent started" event, so `UserPromptSubmit` both discovers cards in the prompt and moves the session to `running`.

## Packaging and configuration

- Export the harness's normal extension entry point; Pi uses a default function receiving `ExtensionAPI`, while Claude Code hooks read one JSON event from stdin.
- Register listeners only—do not start the companion server from the extension.
- Read endpoint from `MDELLO_COMPANION_URL`, defaulting to `http://127.0.0.1:31337`, and strip a trailing slash.
- Keep companion-specific logic isolated so extension load and agent operation remain safe while companion is absent.
- Ship a self-contained bundle. Pi resolves bare imports from the installed extension path rather than the symlink target, so workspace dependencies such as `@mdello/common` must be inlined at build time instead of resolved at load time. Claude Code spawns the hook as a plain script, which has the same requirement.

## Reference implementations

| Harness | Source | Bundle | Installed as |
| --- | --- | --- | --- |
| Pi | [`packages/pi-extension/index.ts`](../packages/pi-extension/index.ts) | `packages/pi-extension/dist/index.js` | symlink in `~/.pi/agent/extensions` |
| Claude Code | [`packages/claude-extension/index.ts`](../packages/claude-extension/index.ts) | `packages/claude-extension/dist/index.js` | symlink in `~/.claude/hooks` plus `hooks` entries in `~/.claude/settings.json` |

### Claude Code specifics

- One process per event, so the hook asks the companion for the session's cards instead of keeping them in memory.
- Discovery reads `prompt` on `UserPromptSubmit`, `tool_input.file_path` on `PostToolUse` (matcher `Edit|MultiEdit|Write`), and the `transcript_path` JSONL on `SessionStart`.
- Never write to stdout: Claude Code feeds hook stdout back as session context on `SessionStart` and `UserPromptSubmit`. Always exit `0`, because exit `2` blocks the session.
