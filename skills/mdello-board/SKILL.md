---
name: mdello-board
description: >
  Read and write the user's personal kanban board, which lives as plain markdown files in
  ~/Documents/mdello. Cards are root-level .md files, ordered columns live in mdello.yml, and each
  card selects its column in YAML frontmatter. Use whenever the user mentions "my board", "mdello",
  kanban columns/cards, todo/doing/done, or asks to add, move, update, archive, or summarize cards.
---

# mdello board

Board root: `~/Documents/mdello`. No server, database, or API. Edit files with normal filesystem
tools. App reads disk on refresh. Human may have app open—touch only cards needed.

## Layout

```text
~/Documents/mdello/
  mdello.yml
  some-card.md
  other-card.md
  archive/2026-08/old.md
```

`mdello.yml` defines ordered columns:

```yaml
columns:
  - Todo
  - Doing
  - Done
```

Cards live directly in board root. `column` frontmatter must exactly match one configured name.
Archive is cold storage and never shown.

## Card format

```markdown
---
uuid: 550e8400-e29b-41d4-a716-446655440000
title: This is my ticket name
column: Todo
tags: [poc, mdello]
created: '2026-08-14T14:59:43.813Z'
assignee: brandon
order: 3
---

Body is markdown description.
```

- `uuid`—stable identity. Generate for new cards (`uuidgen`); never change an existing value.
- `title`—falls back to filename minus `.md`; editable in app.
- `column`—required for display; exact configured column name.
- `tags`—string list. Read-only in app.
- `created`—ISO string or `YYYY-MM-DD`. Read-only in app.
- `assignee`—string. Read-only in app.
- `order`—app-managed card position; do not adjust unless explicitly ordering cards.
- Modified time comes from filesystem. Never write `modified`.
- Extra frontmatter keys survive app round-trips.

## Operations

**Read board**

```bash
read ~/Documents/mdello/mdello.yml
rg --files ~/Documents/mdello -g '*.md' -g '!archive/**'
```

Read configured columns first, then group root card files by `column`.

**Add card**—write into board root. Filename = lowercase title slug, max 60 characters; add `-1`,
`-2`, etc. on collision. Generate a UUID and use a real current UTC timestamp. Mdello backfills
`uuid` if an agent or human omits it, but authors should include it.

```markdown
---
uuid: 550e8400-e29b-41d4-a716-446655440000
title: Fix flaky test
column: Todo
tags: []
created: '2026-08-14T14:59:43.813Z'
---

Body here.
```

**Move card between columns**—edit only its `column` frontmatter. File path stays stable.

**Edit card**—keep valid YAML and first-line `---` fence. Avoid unrelated reformatting.

**Archive card**—move file from board root into `archive/YYYY-MM/`. Do not change frontmatter.
Archived cards are invisible. Only read archive when user asks about history.

**Add, rename, or reorder columns**—edit ordered `columns` list in `mdello.yml`. When renaming or
removing a column, update affected cards' `column` values too.

## Rules

- Do not delete cards. Archive unless user explicitly says delete.
- Do not touch `archive/` during routine work.
- Do not bulk-rewrite unrelated cards; it churns mtimes.
- If board root is missing, say so and ask before creating it.
- If asked to work on a card, set its column to the configured in-progress column and set yourself
  as assignee. At end, add a brief summary and links to Jira tickets or PRs created.
