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
| `idle` | `session_start`, `ui_prompt_end` when idle | `SessionStart` except `source: compact` |
| `running` | `agent_start`, `ui_prompt_end` when busy | `UserPromptSubmit`; matching question, permission, or elicitation result |
| `waiting_for_input` | `ui_prompt_start` | `PreToolUse(AskUserQuestion)`, `PermissionRequest`, `Elicitation`, blocking notifications |
| `ready_for_review` | `agent_settled` | `Stop`, `StopFailure` |
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

- A client exports the harness's normal extension entry point; Pi uses a default function receiving `ExtensionAPI`. An adapter exports a `HarnessAdapter` plus the configuration its installer materializes — for Claude Code, the files of a hooks-only plugin.
- Prefer a drop-in directory over editing a shared config file. An installer that owns one directory is idempotent by construction and cannot damage unrelated settings.
- Register listeners only—do not start the companion server from the extension.
- A client reads its endpoint from `MDELLO_COMPANION_URL`, defaulting to `http://127.0.0.1:31337`, and strips a trailing slash. An adapter's endpoint is fixed when its hooks are installed.
- Keep companion-specific logic isolated so extension load and agent operation remain safe while companion is absent.
- A client must ship a self-contained bundle: Pi resolves bare imports from the installed extension path rather than the symlink target, so workspace dependencies such as `@mdello/common` must be inlined at build time. An adapter needs no bundle, because the companion imports it directly.

## Reference implementations

| Harness | Shape | Source | Installed as |
| --- | --- | --- | --- |
| Pi | client | [`packages/pi-extension/index.ts`](../packages/pi-extension/index.ts) | bundle symlinked into `~/.pi/agent/extensions` |
| Claude Code | adapter | [`packages/claude-extension/index.ts`](../packages/claude-extension/index.ts) | generated plugin directory at `~/.claude/skills/mdello-companion` |

### Claude Code specifics

Transport behavior was verified against Claude Code 2.1.220. Lifecycle mappings also cover newer documented notifications; unsupported notification matchers are inert on older releases.

- **`SessionStart` and `Setup` reject `http` hooks** and are skipped with only a debug log. Session boundary events therefore post with `curl`, at roughly 17 ms once per session; turn events use `type: "http"` and spawn nothing.
- **The integration ships as a plugin, not as settings.** A directory under a skills directory that carries `.claude-plugin/plugin.json` loads as `<name>@skills-dir` on the next session, with no marketplace and no install record, and plugin hooks use the same schema as settings hooks. So install writes one directory and never edits the user's `settings.json`. The manifest carries `metadata.managedBy`, which uninstall requires before deleting anything.
- **`allowedHttpHookUrls` is enforced only when the key exists.** Loopback is exempt from the private-address check, so an unset allowlist permits `127.0.0.1`. A user who maintains an allowlist must add the companion origin themselves, since the installer does not write settings.
- **A dead companion cannot block a session.** A failed hook is reported as a non-blocking error and never reaches the session output. The exception is `SessionEnd`, which writes hook failures to stderr, so its `curl` ends in `|| true`.
- **`enabledPlugins` wins over the manifest.** Running `claude plugin disable mdello-companion@skills-dir` records `false` in settings, and reinstalling does not override it; re-enable with `claude plugin enable`.
- Every hook sets an explicit `timeout`, because the default for `command`, `http`, and `mcp_tool` hooks is 600 seconds.
- The companion must answer with valid JSON or an empty body; invalid JSON raises a hook error. `/hooks/*` replies `{}` and sends no CORS headers, since it reads a caller-supplied session file and must not be reachable from a browser page.
- Discovery reads `prompt` on `UserPromptSubmit`, `tool_input.file_path` on modifying `PostToolUse` events, and the `transcript_path` JSONL on `SessionStart`.
- Claude's official hook inventory is represented by the `ClaudeHookEvent` union and `CLAUDE_HOOK_POLICIES`. A `satisfies Record<ClaudeHookEvent, ClaudeHookPolicy>` check requires every event to be classified as lifecycle-relevant or metadata-only. Hook settings are generated from that policy, preventing subscriptions and translation logic from drifting apart. Upstream Claude additions still require updating the inventory from Anthropic's documentation.
- Lifecycle state is aggregated per session. Outstanding questions, permission requests, and MCP elicitations are keyed by their event identity. A tool result clears only its matching blockers, so parallel tool completion cannot hide an unrelated wait.
- `PreToolUse(AskUserQuestion)` starts a wait; its matching `PostToolUse` or `PostToolUseFailure` resumes work. `PermissionRequest` and `Elicitation` start equivalent blockers, resolved by matching tool results, `PermissionDenied`, or `ElicitationResult`.
- `SessionStart(source=compact)` preserves current state. `StopFailure` settles a failed API turn as `ready_for_review` because the companion has no separate error status.
- Claude hooks cannot reliably observe user interrupt or the exact instant every interactive permission/background prompt resolves. The next prompt, terminal event, or identifiable result reconciles state. Delayed notifications are fallbacks; `idle_prompt` is intentionally ignored.
