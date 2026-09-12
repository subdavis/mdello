---
uuid: 95909660-d632-45a3-8abf-989ea3f7e8ef
title: Delete legacy date helper
column: Backlog
tags:
  - quick-win
created: '2026-08-18T09:15:00.000Z'
assignee: Pi
order: 3
---

## Why

`formatOldDate()` duplicates browser-native `Intl.DateTimeFormat`.

- [ ] Find remaining imports
- [ ] Replace with `formatDate`
- [ ] Remove dead test fixture

See [date-formatting guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat) for replacement API.
