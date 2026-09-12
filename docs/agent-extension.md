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
6. **Track the session's cards:** a harness that keeps one long-lived process may hold them in memory. A harness that fires per event should instead publish through `POST /hooks/<harness>`, where the companion unions the event's discoveries with the cards it already holds for that `(harness, sessionId)`.

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

## Two integration shapes

A harness that loads code into its own process is a **client**: it discovers cards, tracks its session, and posts to `/associations` itself. Pi works this way.

A harness that only offers per-event callbacks is an **adapter**: it posts the raw event payload to `/hooks/<harness>` and the companion does the rest. Claude Code works this way, because spawning a process per lifecycle event costs far more than the work itself — a measured 77 ms for a Node script versus roughly zero for a webhook.

An adapter implements [`HarnessAdapter`](../packages/common/src/harness.ts):

```ts
interface HarnessAdapter {
  harness: string;
  translate(payload: unknown): Promise<HarnessHookEvent | undefined>;
}

interface HarnessHookEvent {
  sessionId: string;
  sessionFile?: string;
  status: AssociationStatus;
  cardPaths: string[];
}
```

Return `undefined` for anything not worth publishing — an unknown event, a missing session id, a tool call on a file that cannot be a card. The adapter lives in its own package and the companion imports it, so no harness-specific lifecycle knowledge reaches the sidecar beyond one registry entry in [`packages/companion/src/hooks.ts`](../packages/companion/src/hooks.ts).

## Packaging and configuration

- A client exports the harness's normal extension entry point; Pi uses a default function receiving `ExtensionAPI`. An adapter exports a `HarnessAdapter` plus whatever configuration its installer needs to write.
- Register listeners only—do not start the companion server from the extension.
- A client reads its endpoint from `MDELLO_COMPANION_URL`, defaulting to `http://127.0.0.1:31337`, and strips a trailing slash. An adapter's endpoint is fixed when its hooks are installed.
- Keep companion-specific logic isolated so extension load and agent operation remain safe while companion is absent.
- A client must ship a self-contained bundle: Pi resolves bare imports from the installed extension path rather than the symlink target, so workspace dependencies such as `@mdello/common` must be inlined at build time. An adapter needs no bundle, because the companion imports it directly.

## Reference implementations

| Harness | Shape | Source | Installed as |
| --- | --- | --- | --- |
| Pi | client | [`packages/pi-extension/index.ts`](../packages/pi-extension/index.ts) | bundle symlinked into `~/.pi/agent/extensions` |
| Claude Code | adapter | [`packages/claude-extension/index.ts`](../packages/claude-extension/index.ts) | `hooks` entries in `~/.claude/settings.json` |

### Claude Code specifics

Verified against Claude Code 2.1.220. The first two points are not documented and were confirmed by inspecting the binary and by running hooks against a capture server.

- **`SessionStart` and `Setup` reject `http` hooks** and are skipped with only a debug log. Those two events therefore post with `curl`, at roughly 17 ms once per session; the four per-turn events use `type: "http"` and spawn nothing.
- **`allowedHttpHookUrls` is enforced only when the key exists.** Loopback is exempt from the private-address check, so an unset allowlist permits `127.0.0.1`. The installer appends the companion URL when a user already maintains an allowlist and never creates one.
- **A dead companion cannot block a session.** A failed hook is reported as a non-blocking error and never reaches the session output. The exception is `SessionEnd`, which writes hook failures to stderr, so its `curl` ends in `|| true`.
- Every hook sets an explicit `timeout`, because the default for `command`, `http`, and `mcp_tool` hooks is 600 seconds.
- The companion must answer with valid JSON or an empty body; invalid JSON raises a hook error. `/hooks/*` replies `{}` and sends no CORS headers, since it reads a caller-supplied session file and must not be reachable from a browser page.
- Discovery reads `prompt` on `UserPromptSubmit`, `tool_input.file_path` on `PostToolUse` (matcher `Edit|MultiEdit|Write`), and the `transcript_path` JSONL on `SessionStart`.
