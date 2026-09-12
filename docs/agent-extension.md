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

## Packaging and configuration

- Export the harness's normal extension entry point; Pi uses a default function receiving `ExtensionAPI`.
- Register listeners only—do not start the companion server from the extension.
- Read endpoint from `MDELLO_COMPANION_URL`, defaulting to `http://127.0.0.1:31337`, and strip a trailing slash.
- Keep companion-specific logic isolated so extension load and agent operation remain safe while companion is absent.

Pi reference implementation: [`companion/pi-extension.ts`](../companion/pi-extension.ts).
