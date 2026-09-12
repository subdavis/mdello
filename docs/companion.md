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

Identity is `(boardUuid, cardUuid, harness, sessionId)`. A session may associate with multiple cards, and a card may associate with multiple sessions. UUIDs preserve identity across card moves; paths are only a legacy fallback. Companion accepts only active, direct-child cards with UUIDs from registered boards.

## HTTP API

Default origin: `http://127.0.0.1:31337`. JSON request bodies are limited to 64 KiB. CORS is open for the local web app.

| Request | Contract |
| --- | --- |
| `POST /associations` | Body contains `markdownPath` (or `cardPath`), `harness`, `sessionId`, optional `sessionFile`, and `status`. Resolves board/card UUIDs and returns recorded association (`202`). Unknown cards are ignored (`202`, `{ ignored: true, reason: "unknown_card" }`). |
| `GET /associations[?boardUuid=…&cardUuid=…]` | Returns latest associations, optionally filtered by board and card. |
| `DELETE /associations?boardUuid=…&cardUuid=…` | Permanently removes all persisted events for that card and broadcasts fresh snapshots. |
| `GET /events?boardUuid=…&boardPath=…` | Validates and registers board, reconciles stored paths/UUIDs, then opens SSE stream. Sends `snapshot` first and `association` after each update for that board. |
| `POST /backfill` | Body: `{ boardUuid, boardPath }`. UUID must match `mdello.yml`. Rebuilds that board's associations and broadcasts fresh snapshots. |

Errors use `{ error: string }`. Invalid requests return `400`, internal backfill/delete failures `500`, and unknown routes `404`.

## Commands

```text
mdello-companion serve                     Start sidecar (default command)
mdello-companion backfill /absolute/board  Rebuild one board, then exit
mdello-companion status                    List tracked boards and event counts
mdello-companion purge                     Clear association history
mdello-companion reset                     Alias for purge
```

Configuration: `MDELLO_COMPANION_PORT` (default `31337`), `MDELLO_COMPANION_DATA` (default `~/.mdello/companion.jsonl`), and `MDELLO_COMPANION_CONFIG` (default `~/.mdello/companion.json`). Set `DEBUG=1` for structured stderr logs.

## Behavior

- **Persistence:** updates append to JSONL; loading folds events by association identity. Card deletion expunges history instead of appending a tombstone.
- **Board registration:** subscribing or backfilling records stable board UUID + current absolute path. Registration rejects a UUID that does not match the board's `mdello.yml`.
- **Reconciliation:** subscription refreshes moved paths from card UUIDs and removes associations for cards no longer active.
- **Backfill:** scans Pi JSONL sessions modified within 30 days. It associates absolute card paths found in user messages and successful Markdown `edit` or `write` calls. It replaces only the requested board, preserves other boards, retains a matching live non-`closed` status, marks recovered sessions `closed`, and removes stale matches.
- **Subscription:** each client receives only its board. Initial/reconciliation/backfill/delete state uses `snapshot`; live updates use `association`. Browser reconnects after one second and replaces local state on snapshots.
