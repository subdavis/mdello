import assert from 'node:assert/strict';
import test from 'node:test';
import { groupColumns } from '../src/fs/columns.ts';

test('prepends virtual columns for card columns missing from config', () => {
  const cards = [
    { name: 'configured.md', column: 'Todo' },
    { name: 'later.md', column: 'Typo' },
    { name: 'blank.md', column: '' },
    { name: 'invented.md', column: 'Invented' },
    { name: 'earlier.md', column: 'Typo' },
  ];

  const columns = groupColumns(cards, ['Todo', 'Done']);

  assert.deepEqual(
    columns.map(({ name, virtual }) => ({ name, virtual })),
    [
      { name: '', virtual: true },
      { name: 'Invented', virtual: true },
      { name: 'Typo', virtual: true },
      { name: 'Todo', virtual: false },
      { name: 'Done', virtual: false },
    ],
  );
  assert.deepEqual(
    columns.find((column) => column.name === 'Typo').cards.map((card) => card.name),
    ['later.md', 'earlier.md'],
  );
});
