---
name: mdello-board
description: >
  Read and write the user's personal kanban board, which lives as plain markdown files in
  ~/Documents/mdello. Folders are columns, .md files are cards, YAML frontmatter is metadata. Use
  whenever the user mentions "my board", "mdello", kanban columns/cards, todo/doing/done, or asks
  to add, move, update, archive, or summarize board cards. The human uses the mdello web app; an
  agent just edits the files directly.
---

# mdello board

Board root: `~/Documents/mdello`. No server, no database, no API. Board is files. Edit files with
normal tools (`ls`, `read`, `edit`, `write`, `mv`).

App reads disk on refresh, so file edits show up. Human may have app open — do not rewrite
everything, touch only cards you need.

## Layout

```
~/Documents/mdello/
  1-todo/some-card.md         # numeric prefix = column order, stripped from label
  2-doing/other-card.md
  3-done/done-card.md
  archive/2026-08/old.md      # archive never shown in app
```

- Column = directory. Order from numeric prefix (`1-`, `2-`...); no prefix sorts last.
- Label = dir name minus prefix, `-`/`_` → spaces, Title Cased. `1-todo` → "Todo".
- Card = `*.md` file. Non-md files and dotdirs ignored.
- Cards sorted newest-mtime-first in app. To bump card to top, just touch/edit it.

## Card format

```markdown
---
title: This is my ticket name
tags: [poc, mdello]
created: '2026-08-14T14:59:43.813Z'
assignee: brandon
order: 3
---

Body is markdown description. Bullets, code fences, whatever.
```

- `title` — required-ish; falls back to filename minus `.md`. Editable in app.
- `tags` — list of strings (flow or block YAML both fine); comma string also parsed. Read-only in app.
- `created` — ISO string or `YYYY-MM-DD`. Read-only in app.
- `assignee` — string, read-only in app.
- `order` - user will order cards, dont worry about this.
- Modified time comes from filesystem, not frontmatter. Never write a `modified` key.
- Malformed frontmatter = treated as empty metadata, card still shows. Keep YAML valid.
- Extra frontmatter keys survive round-trips but app ignores them.

## Operations

**Read board**
```bash
ls ~/Documents/mdello
rg --files ~/Documents/mdello -g '*.md' -g '!archive/**'
```

**Add card** — write file into column dir. Filename = slug of title, lowercase, non-alnum → `-`,
max 60 chars, `-1`, `-2` suffix on collision.
```bash
cat > ~/Documents/mdello/1-todo/fix-flaky-test.md <<'EOF'
---
title: Fix flaky test
tags: []
created: '2026-08-14T14:59:43.813Z'
---

Body here.
EOF
```
Use real current UTC ISO timestamp (`date -u +%Y-%m-%dT%H:%M:%S.000Z`).

**Move card between columns** — `mv` the file. Nothing else changes.
```bash
mv ~/Documents/mdello/1-todo/fix-flaky-test.md ~/Documents/mdello/2-doing/
```

**Edit card** — normal edit tool on the file. Keep frontmatter fence `---` first line.

**Archive card** — move into `archive/YYYY-MM/` (current month), create dir if missing.
```bash
mkdir -p ~/Documents/mdello/archive/$(date +%Y-%m)
mv ~/Documents/mdello/3-done/thing.md ~/Documents/mdello/archive/$(date +%Y-%m)/
```
Archived cards are invisible in app. Only read archive if user asks about history.

**New column** — `mkdir ~/Documents/mdello/4-blocked`. Prefix sets position.

## Rules

- Do not delete cards. Archive instead, unless user says delete.
- Do not touch `archive/` for routine work; it is the cold store.
  Though you are permitted to search it if you can't find elsewhere.
- Do not reformat unrelated cards or bulk-rewrite frontmatter; it churns mtimes and reorders the
  board for the human.
- If `~/Documents/mdello` missing, say so and ask before creating it.

If the user asks you to work on a card, move that card to in progress and set yourself as the assignee. Update the ticket with a very brief summary of what you did at the end, with a link to jira tickets or PRs created.