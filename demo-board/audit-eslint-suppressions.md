---
uuid: 54b6b1b8-f76d-4dcd-a498-215acb5ca3c8
title: Audit ESLint suppressions
column: Ready
tags:
  - quick-win
created: '2026-08-19T13:45:00.000Z'
assignee: Claude
order: 2
---

Start with suppressions missing a reason. Keep exceptions that protect intentional behavior.

1. Search `eslint-disable`
2. Add a reason or fix rule violation
3. Record counts in PR description

Related issue: https://github.com/acme/clean-code/issues/42
