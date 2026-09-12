<p align="center">
<img src="./packages/client/public/Mdello.png" width="260px">
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
| ![Filesystem](./packages/client/public/filesystem2.png) | ![PWA Screenshot](./packages/client/public/screenshot.png) |

Mdello can be installed as a PWA.

![Install PWA](./packages/client/public/install-pwa.png)

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

### Install companion integrations

From a cloned repository, build the agent extension bundles, then install every supported
integration for the current platform:

```bash
yarn build:pi-extension
yarn build:claude-extension
npx mdello-companion install
npx mdello-companion install macos
npx mdello-companion install pi
npx mdello-companion install claude
```

Both agent installs link a bundle out of the repository, so rebuild after changing extension or
`@mdello/common` sources:

| Integration | Installs |
| --- | --- |
| `macos` | `~/Library/LaunchAgents/com.mdello.companion.plist`, started with `launchctl` |
| `pi` | `packages/pi-extension/dist/index.js` symlinked into `~/.pi/agent/extensions` |
| `claude` | `packages/claude-extension/dist/index.js` symlinked into `~/.claude/hooks`, plus `hooks` entries in `~/.claude/settings.json` |

Every install command is safe to rerun and updates its existing installation. The Claude install
rewrites only its own `hooks` entries and leaves the rest of `settings.json` untouched; it refuses
to run at all when that file is not valid JSON.

Remove every integration, or one integration, with:

```bash
npx mdello-companion uninstall
```

After installing or removing the Pi integration, run `/reload` in Pi. Claude Code picks up hook
changes in its next session.

### Agent plugins

Companion integration is disabled by default. Click the companion badge in the toolbar to toggle it;
the choice is stored as `companion: true` or `companion: false` in `mdello.yml`. When enabled, the
frontend connects to `http://127.0.0.1:31337` and displays each associated session in card modal
metadata. Status follows the agent lifecycle: `idle`, `running`, `waiting_for_input`,
`ready_for_review`, or `closed`. Opening a ready card acknowledges it back to `idle`. Set
`MDELLO_COMPANION_PORT`, `MDELLO_COMPANION_DATA`, or `MDELLO_COMPANION_URL` for
extension/sidecar overrides. Set `VITE_MDELLO_COMPANION_URL` when frontend endpoint differs.

Pi and Claude Code both discover associations from absolute Markdown paths in user input and from
successful Markdown edit or write tool calls, including relative paths resolved against the session
working directory. On session start each one also rescans its own session history, so a card
associates even when the companion was down at the time. Associations include a `harness`
identifier (`pi` or `claude`) and are keyed by stable board and card UUIDs, so moving or renaming a
card keeps its identity. The session badge in a card modal copies a resume command for that
harness (`pi --session …` or `claude --resume …`).

See [`docs/agent-extension.md`](docs/agent-extension.md) for the lifecycle event mapping and the
contract a new harness must satisfy.

## Repository layout

This repository is a Yarn workspace monorepo:

- `packages/client` — Vue PWA deployed to GitHub Pages
- `packages/companion` — local sidecar and CLI; private until ready for npm
- `packages/pi-extension` — Pi lifecycle integration
- `packages/claude-extension` — Claude Code lifecycle integration, installed as hooks
- `packages/common` — shared association, frontmatter, and path helpers

## Local development

```bash
mise install
yarn install
yarn dev
```

Root scripts delegate to workspaces. Use `yarn companion` to start sidecar and `yarn test`,
`yarn typecheck`, or `yarn build` to validate repository.
