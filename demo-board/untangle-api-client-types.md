---
uuid: 56069d40-bb62-477a-a88a-00a2711f753a
title: Untangle API client types
column: Backlog
tags:
  - tech-debt
created: '2026-08-18T10:30:00.000Z'
order: 4
---

`ApiResponse`, `ServerResponse`, and `ResponseData` describe same payload at three layers.

> Goal: one exported domain type per endpoint, transport details private.

Design notes: https://www.figma.com/file/clean-code-demo/api-client-types

```ts
type User = { id: string; name: string }
```
