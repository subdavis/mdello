<p align="center">
<img src="./public/Mdello.png" width="260px">
</p>

Trello-style board that reads and writes plain markdown files on your local disk.

- 100% local, no server, no database.
- `.md` files are cards; ordered columns live in `mdello.yml` and card frontmatter.
- Uses the Filesystem API, requires a [Chromium-based browser](https://caniuse.com/filesystem)
- Designed to share your personal TODOs with AI agents - No MCP, tools or auth needed.
- 🍻 Pronounced like the beer

**Try it out at https://subdavis.github.io/mdello/**

## User Guide

| Your files                              | Your board                                 |
| --------------------------------------- | ------------------------------------------ |
| ![Filesystem](./public/filesystem2.png) | ![PWA Screenshot](./public/screenshot.png) |

Mdello can be installed as a PWA.

![Install PWA](./public/install-pwa.png)

Recommend creating the folder at `~/Documents/mdello`

Open the app, click **Open folder…**, pick your folder. The folder handle is cached in IndexedDB, so
later visits only need a single **Reconnect** click to re-grant write permission.

### Switching boards

Every folder you open is remembered. Press <kbd>⌘P</kbd> (<kbd>Ctrl</kbd>+<kbd>P</kbd>) or click the
board name in the toolbar to bring up the switcher: arrow keys to move, <kbd>Enter</kbd> to switch,
<kbd>Esc</kbd> to dismiss. Because the handles are cached, swapping boards never re-opens the file
picker. Boards are listed by their `path` from `mdello.yml` where one is set, since every board
folder tends to be called `content`. The **×** on a row drops it from the list and leaves the files
alone.

### Agent Skills

The purpose of the filesystem-based approach is to give AI agents complete access to your board without any external tools, MCP, or auth. It's just files! You can tell your agent about your board with a simple skill.

```bash
npx skills add https://github.com/subdavis/mdello/blob/main/skills/mdello-board
```

### Board layout

```
content/
  mdello.yml                # Config, including ordered columns
  fix-a-bug.md              # column selected by frontmatter
  ship-release.md
  archive/2026-08/card.md   # never scanned, never shown
```

Opening a legacy board with folder-based columns prompts once to migrate it. Mdello moves each card
to the board root, adds `column` and `uuid` frontmatter, and writes ordered columns to `mdello.yml`.

### Frontmatter

- `uuid` is stable card identity; Mdello creates it for new cards and backfills missing values
- `title` is editable
- `column` selects a name from the ordered `columns` list in `mdello.yml`
- `order` is managed by drag order
- `tags`, `assignee` and `created` are read-only
- modification time comes from the file itself.

Editing: click a card to open it, double-click the description for a raw markdown editor. Changes
autosave after a short pause; **Save** exits edit mode and re-renders.

Drop files onto an open card to attach them. Files are stored centrally in
`attachments/`; each card tracks its files in frontmatter. Images appear as thumbnails
above the description and open in a full-size viewer. Other file types open in the browser.

### Configuration & Customization

See `mdello.yml` in your mdello board folder to configure:

- Ordered column names
- Open-in-editor setup
- Tag customization

Drag any image onto the window to set the background image.

## Agent companion

Companion proof of concept associates cards with Pi sessions when a user prompt contains an
absolute card path. Start local HTTP/SSE sidecar:

```bash
yarn companion
```

Backfill associations from existing Pi session files, then exit without starting the server:

```bash
yarn companion backfill
```

Backfill is idempotent: existing live associations keep their status, and only missing historical
associations are appended as `closed`.

Clear persisted companion session data before restarting the sidecar:

```bash
yarn companion reset
```

Stop any running companion sidecar first; its in-memory associations remain until it restarts.

### Run continuously with launchd (macOS)

Install a per-user `LaunchAgent` so the companion starts at login and restarts after it exits.

```bash
./companion/install-launchd.sh
```

To stop and remove agent:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.mdello.companion.plist
rm ~/Library/LaunchAgents/com.mdello.companion.plist
```

### Agent plugins

Install Pi extension globally as a directory so its sibling modules resolve, then run `/reload`
in Pi:

```bash
ln -s "$(pwd)/companion" ~/.pi/agent/extensions/mdello-companion
```

Companion integration is disabled by default. Click the companion badge in the toolbar to toggle it;
the choice is stored as `companion: true` or `companion: false` in `mdello.yml`. When enabled, the
frontend connects to `http://127.0.0.1:31337` and displays each associated session in card modal
metadata. Status follows Pi lifecycle: `idle`, `running`, `waiting_for_input`,
`ready_for_review`, or `closed`. Opening a ready card acknowledges it back to `idle`. Set
`MDELLO_COMPANION_PORT`, `MDELLO_COMPANION_DATA`,
`MDELLO_COMPANION_URL`, or `MDELLO_BOARD_PATH` for extension/sidecar overrides. Set
`VITE_MDELLO_COMPANION_URL` when frontend endpoint differs.

Associations include a `harness` identifier (`pi` for the Pi extension) and use absolute card paths.
Moving a card between columns keeps its identity because the file remains in the board root;
archiving still changes its path.

## Local development

```bash
mise install
yarn install
yarn dev
```
