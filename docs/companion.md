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
  herdrWorkspace?: string; // transient; present when current Herdr pane resolves
  herdrTab?: string; // transient; present when current Herdr pane resolves
  status: AssociationStatus;
  updatedAt: string; // ISO-8601, assigned by companion
}
```

Identity is `(cardUuid, harness, sessionId)`. Card UUIDs are global, so associations survive renames and moves between registered boards. `boardUuid` and `cardPath` describe the card's current location and filter each board's event stream; paths are also a legacy identity fallback. A session may associate with multiple cards, and a card may associate with multiple sessions. Companion accepts only active, direct-child cards with UUIDs from registered boards.

## HTTP API

Default endpoint: `http://127.0.0.1:51618`. JSON request bodies are limited to 64 KiB. The server accepts only loopback `Host` values. Browser-facing routes allow loopback origins plus the configured `webOrigin`, return matching CORS headers, and reject other `Origin` or `Referer` values with `403`. Requests without browser source headers remain available to local clients.

| Request | Contract |
| --- | --- |
| `POST /associations` | Body contains `markdownPath` (or `cardPath`), `harness`, `sessionId`, optional `sessionFile`, and `status`. Resolves board/card UUIDs and returns recorded association (`202`). New sessions resolve against cached Herdr state; an unknown session triggers one state sync and is negatively cached if still unresolved. Unknown cards are ignored (`202`, `{ ignored: true, reason: "unknown_card" }`). |
| `GET /associations[?boardUuid=…&cardUuid=…]` | Returns latest associations, optionally filtered by board and card. When Herdr is available and a session resolves to a current pane, its association includes transient `herdrWorkspace` and `herdrTab` labels. |
| `DELETE /associations?cardUuid=…` | Permanently removes all persisted events for that global card and broadcasts fresh snapshots. |
| `DELETE /associations?harness=…&sessionId=…` | Forgets that harness session across every card by removing all its persisted events, then broadcasts fresh snapshots. |
| `DELETE /associations?cardUuid=…&harness=…&sessionId=…` | Forgets that harness session from only the selected card, preserving its associations with other cards. |
| `GET /events?boardUuid=…&boardPath=…` | Validates and registers board, reconciles stored paths/UUIDs, then opens SSE stream. One Herdr state sync runs when the frontend connects. Sends `snapshot` first and `association` after each update for that board, enriched from the companion's cached Herdr state when resolvable. |
| `POST /hooks/<harness>` | Body is that harness's raw lifecycle payload. A registered [harness adapter](agent-extension.md) translates it; the companion publishes to the event's cards plus every card already held for that `(harness, sessionId)`. Sessions resolve against cached Herdr state; an unknown session triggers one state sync, and a still-unresolved session is negatively cached. Always answers `{}`. Browser requests carrying `Origin`, `Referer`, or `Sec-Fetch-Site` are rejected with `403`; hooks are for local agent clients only. Unknown harness returns `404`. |
| `GET /settings` | Returns `{ autofocus, githubEnabled, herdrEnabled, jiraEnabled, linkEnrichment }`; CLI controls are enabled when their executable is configured through `GH_PATH`/`HERDR_PATH`/`JIRA_PATH` or discovered on the companion's active `PATH`. |
| `POST /settings` | Persists either `{ autofocus: boolean }` or `{ linkEnrichment: boolean }` in the companion config. The single link setting controls every available enrichment provider. |
| `GET /enrichments?url=…` | Opens the provider-neutral SSE subscription for up to 50 repeated `url` parameters. Emits cached `{ items, errors }` first, immediately refreshes URLs through their registered providers, streams results as each lookup settles, and polls every 30 seconds until the client disconnects. Every item includes a `provider` discriminator. GitHub active PRs include `ciStatus` as `passing`, `failing`, `pending`, or `none`; closed and merged PRs omit it. Jira issues include their key, status, and title. Successful results are cached in companion memory. Returns `409` when no enrichment providers are available and `400` for unsupported URLs. |
| `POST /actions` | Body is `{ action, ... }`. Actions live in their own module ([`actions.ts`](../packages/companion/src/actions.ts)), isolated from the association/board logic above, as a small `ACTIONS` registry keyed by action name. Returns `200 { ok: true }` on success, `400` for a body that isn't a recognized action, `500` if the herdr CLI itself fails. |
| ↳ `focus` | `{ action: "focus", harness, sessionId, sessionFile? }` — the session to focus. Joins `herdr agent list` against `sessionId` (or `sessionFile` for `harness: pi`), runs `herdr agent focus <pane_id>`, then projects its `tab_id` to attached Herdr clients with `herdr tab focus <tab_id>`. `404` if no pane matches, `409` if `herdr` is unavailable through both `HERDR_PATH` and `PATH`. |

Errors use `{ error: string }`. Invalid requests return `400`, internal delete failures `500`, and unknown routes `404`. Backfill is deliberately absent: it rewrites the whole log, so it is a CLI command only.

## Commands

```text
mdello-companion serve                        Start sidecar (default command)
mdello-companion backfill [claude|opencode|pi] Rebuild one harness from its sessions, or all, then exit
mdello-companion status                       List tracked boards and event counts
mdello-companion purge                        Clear association history
mdello-companion reset                        Alias for purge
mdello-companion install [macos|pi|opencode|claude]    Install integrations, or one of them
mdello-companion uninstall [macos|pi|opencode|claude]  Remove integrations, or one of them
mdello-companion help                         Print commands and configuration (aliases -h, --help)
```

`help` builds its command and environment lists from `BACKFILL_SOURCES`, `INTEGRATIONS`, and the default port and file paths, so it cannot drift from the code. An unknown command prints the same text on stderr and exits `1`.

Configuration: `MDELLO_COMPANION_PORT` defaults to `51618`. `MDELLO_COMPANION_CONFIG` defaults
to `${XDG_CONFIG_HOME:-~/.config}/mdello/companion.json`, while `MDELLO_COMPANION_DATA` defaults
to `${XDG_STATE_HOME:-~/.local/state}/mdello/companion.jsonl`. Explicit `MDELLO_COMPANION_*`
file overrides win over XDG defaults. Empty or relative XDG directory values are ignored, following
the XDG base-directory specification. Backfill reads `CLAUDE_SESSIONS_DIR` (default
`~/.claude/projects`), `OPENCODE_SESSIONS_DB` (default
`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`), and `PI_SESSIONS_DIR` (default
`~/.pi/agent/sessions`). Set `DEBUG=1` for
structured stderr logs. When `HERDR_PATH` is unset, an interactively started companion discovers
`herdr` from its active `PATH`. Link enrichment similarly discovers `gh` and `jira` when `GH_PATH`
and `JIRA_PATH` are unset.

The macOS installer interactively confirms the current Node executable and any discovered `herdr`,
`gh`, or `jira` executable. Their absolute paths are stored as `HERDR_PATH`, `GH_PATH`, and
`JIRA_PATH` in the launchd service because launchd does not inherit the shell `PATH`. Jira
credentials are not copied into the plist: `HOME` lets jira-cli use its normal config plus a
matching `~/.netrc` entry or login-keychain credential. It stops the launch agent before moving legacy files from `~/.mdello`. Each file is moved
only when its XDG destination is absent: config goes to the config directory; event history and
stdout/stderr logs go to the state directory. It then writes absolute executable and XDG paths into
the launchd plist without copying the shell `PATH`, restarts the service, and removes `~/.mdello`
when empty. Missing `herdr` is allowed and disables herdr actions.

`companion.json` holds `boards`, `autofocus`, link-enrichment settings, and user-edited settings. `webOrigin` is the HTTP(S) origin allowed to call browser-facing routes and defaults to `https://subdavis.github.io`; configure an origin only, without an application path. Loopback browser origins remain allowed for local development. Saving board registrations or autofocus preserves every other setting.

```json
{
  "autofocus": true,
  "linkEnrichment": true,
  "webOrigin": "https://example.com"
}
```

Restart the companion after changing these settings.

## Behavior

- **Persistence:** updates append to JSONL; loading folds events by association identity. Card deletion and session forgetting expunge history instead of appending a tombstone.
- **Board registration:** subscribing records a stable board UUID + current absolute path.
- **Reconciliation:** subscription locates global card UUIDs across every registered board, refreshes board/path metadata after moves, and removes associations for cards no longer active.
- **Backfill:** an explicit maintenance command, never triggered by the web app. It scans one named harness's sessions updated within 30 days against every registered board, reading Pi and Claude Code JSONL transcripts or OpenCode's SQLite database through that harness's own scanner. It associates absolute card paths found in user messages plus Markdown files a *successful* tool call modified. It replaces that harness's associations globally, passes every other harness's through untouched, retains a matching live non-`closed` status, marks recovered sessions `closed`, and removes stale matches. It refuses to run while a companion holds the port, because the server keeps associations in memory and would overwrite the result.
- **Subscription:** each client receives only its board. Initial/reconciliation/delete state uses `snapshot`; live updates use `association`. Browser reconnects after one second and replaces local state on snapshots.
