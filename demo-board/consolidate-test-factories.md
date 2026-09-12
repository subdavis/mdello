---
uuid: d7747834-db2b-402c-8ae0-14175d6e9c94
title: Consolidate test factories
column: Ready
tags:
  - tests
created: '2026-08-20T09:20:00.000Z'
order: 1
---

Move repeated `makeUser` and `makeProject` builders into `test/factories/`.

- [ ] Preserve meaningful defaults
- [ ] Allow focused overrides
- [ ] Document factory conventions

Read [Testing Library guiding principles](https://testing-library.com/docs/guiding-principles/) before changing integration fixtures.
