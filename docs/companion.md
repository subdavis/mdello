# Companion contract

The companion is an optional local HTTP/SSE sidecar. Agent work must continue when it is unavailable.

## Association

```ts
type AssociationStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'ready_for_review'
  | 'closed';

interface Association {
  boardUuid: string;
  cardUuid: string;
  cardPath: string; // absolute .md path
  harness: string;
  sessionId: string;
  sessionFile?: string;
  status: AssociationStatus;
  updatedAt: string; // ISO-8601, assigned by companion
}
```

Identity is `(cardUuid, harness, sessionId)`. Card UUIDs are global, so associations survive renames and moves between registered boards. `boardUuid` and `cardPath` describe the card's current location and filter each board's event stream; paths are also a legacy identity fallback. A session may associate with multiple cards, and a card may associate with multiple sessions. Companion accepts only active, direct-child cards with UUIDs from registered boards.

## HTTP API

Default origin: `http://127.0.0.1:31337`. JSON request bodies are limited to 64 KiB. CORS is open for the local web app.

| Request | Contract |
| --- | --- |
| `POST /associations` | Body contains `markdownPath` (or `cardPath`), `harness`, `sessionId`, optional `sessionFile`, and `status`. Resolves board/card UUIDs and returns recorded association (`202`). Unknown cards are ignored (`202`, `{ ignored: true, reason: "unknown_card" }`). |
| `GET /associations[?boardUuid=…&cardUuid=…]` | Returns latest associations, optionally filtered by board and card. |
| `DELETE /associations?cardUuid=…` | Permanently removes all persisted events for that global card and broadcasts fresh snapshots. |
| `GET /events?boardUuid=…&boardPath=…` | Validates and registers board, reconciles stored paths/UUIDs, then opens SSE stream. Sends `snapshot` first and `association` after each update for that board. |
| `POST /hooks/<harness>` | Body is that harness's raw lifecycle payload. A registered [harness adapter](agent-extension.md) translates it; the companion publishes to the event's cards plus every card already held for that `(harness, sessionId)`. Always answers `{}`, and sends no CORS headers because it reads a caller-supplied session file. Unknown harness returns `404`. |
| `GET /settings` | Returns `{ herdrEnabled: boolean }`, true when `herdrBundleId` is configured. The client uses this to decide whether to show herdr-only controls. |
| `POST /actions` | Body is `{ action, ... }`. Actions live in their own module ([`actions.ts`](../packages/companion/src/actions.ts)), isolated from the association/board logic above, as a small `ACTIONS` registry keyed by action name. Returns `200 { ok: true }` on success, `400` for a body that isn't a recognized action, `500` if the herdr CLI itself fails. |
| ↳ `focus` | `{ action: "focus", harness, sessionId, sessionFile? }` — the session to focus. Joins `herdr agent list` against `sessionId` (or `sessionFile` for `harness: pi`), runs `herdr agent focus <pane_id>`, then `open -b <herdrBundleId>` to raise the terminal. `404` if no pane matches, `409` if no `herdrBundleId` is configured. |

Errors use `{ error: string }`. Invalid requests return `400`, internal delete failures `500`, and unknown routes `404`. Backfill is deliberately absent: it rewrites the whole log, so it is a CLI command only.

## Commands

```text
mdello-companion serve                        Start sidecar (default command)
mdello-companion backfill [claude|pi]         Rebuild one harness from its sessions, or both, then exit
mdello-companion status                       List tracked boards and event counts
mdello-companion purge                        Clear association history
mdello-companion reset                        Alias for purge
mdello-companion install [macos|pi|claude]    Install integrations, or one of them
mdello-companion uninstall [macos|pi|claude]  Remove integrations, or one of them
mdello-companion help                         Print commands and configuration (aliases -h, --help)
```

`help` builds its command and environment lists from `BACKFILL_SOURCES`, `INTEGRATIONS`, and the default port and file paths, so it cannot drift from the code. An unknown command prints the same text on stderr and exits `1`.

Configuration: `MDELLO_COMPANION_PORT` (default `31337`), `MDELLO_COMPANION_DATA` (default `~/.mdello/companion.jsonl`), and `MDELLO_COMPANION_CONFIG` (default `~/.mdello/companion.json`). Backfill reads `CLAUDE_SESSIONS_DIR` (default `~/.claude/projects`) and `PI_SESSIONS_DIR` (default `~/.pi/agent/sessions`). Set `DEBUG=1` for structured stderr logs.

`companion.json` holds `boards` plus user-edited settings the companion never writes itself — currently just `herdrBundleId`, the bundle id of the terminal emulator herdr runs in (e.g. `com.mitchellh.ghostty`), needed to raise the right app window without an Automation (TCC) grant a launchd agent could never obtain. Saving board registrations preserves that key rather than overwriting the file.

## Behavior

- **Persistence:** updates append to JSONL; loading folds events by association identity. Card deletion expunges history instead of appending a tombstone.
- **Board registration:** subscribing records a stable board UUID + current absolute path.
- **Reconciliation:** subscription locates global card UUIDs across every registered board, refreshes board/path metadata after moves, and removes associations for cards no longer active.
- **Backfill:** an explicit maintenance command, never triggered by the web app. It scans one named harness's JSONL sessions modified within 30 days against every registered board, reading Pi sessions and Claude Code transcripts through that harness's own scanner. It associates absolute card paths found in user messages plus Markdown files a *successful* tool call modified. It replaces that harness's associations globally, passes every other harness's through untouched, retains a matching live non-`closed` status, marks recovered sessions `closed`, and removes stale matches. It refuses to run while a companion holds the port, because the server keeps associations in memory and would overwrite the result.
- **Subscription:** each client receives only its board. Initial/reconciliation/delete state uses `snapshot`; live updates use `association`. Browser reconnects after one second and replaces local state on snapshots.
