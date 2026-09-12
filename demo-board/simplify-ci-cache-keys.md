---
uuid: 9ba06a1d-0628-42d8-9155-cc0b63cd5aee
title: Simplify CI cache keys
column: Cleaning
tags: []
created: '2026-08-21T12:25:00.000Z'
order: 4
---

Current cache key includes branch name, causing avoidable misses. Keep lockfile hash and runtime version.

> Measure cache-hit rate before and after. Fast builds beat clever keys.

Workflow reference: https://github.com/acme/clean-code/issues/56
