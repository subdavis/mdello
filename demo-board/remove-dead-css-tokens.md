---
uuid: 4fe2a0fc-72b5-4413-afb4-2f330ec2b0e5
title: Remove dead CSS tokens
column: Shiny
tags:
  - quick-win
created: '2026-08-21T08:40:00.000Z'
assignee: Codex
order: 3
---

Scanning theme output now. Delete tokens with no source usage; do **not** delete generated aliases until migration completes.

```bash
rg --glob '*.{ts,tsx,vue,css}' -- '--color-legacy-'
```

PR: https://github.com/acme/clean-code/pull/87
