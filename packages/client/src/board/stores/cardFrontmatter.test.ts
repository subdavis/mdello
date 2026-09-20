import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card } from '../../types/board.ts';
import { splitToken, toFrontmatter } from './cardFrontmatter.ts';

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-uuid',
    uuid: 'card-uuid',
    name: 'card.md',
    column: 'Todo',
    title: 'A card',
    tags: [],
    modified: 0,
    body: 'body text',
    attachments: [],
    references: [],
    data: { uuid: 'card-uuid' },
    ...overrides,
  };
}

test('keeps frontmatter keys the app knows nothing about', () => {
  const data = toFrontmatter(
    card({ data: { uuid: 'card-uuid', sessionAssociations: [{ harness: 'claude' }], mood: 'ok' } }),
  );

  assert.deepEqual(data.sessionAssociations, [{ harness: 'claude' }]);
  assert.equal(data.mood, 'ok');
  assert.equal(data.uuid, 'card-uuid');
});

test('writes the fields the board owns over whatever the file had', () => {
  const data = toFrontmatter(
    card({
      title: 'Renamed',
      column: 'Doing',
      order: 4,
      data: { uuid: 'card-uuid', title: 'Stale', column: 'Todo', order: 1 },
    }),
  );

  assert.equal(data.title, 'Renamed');
  assert.equal(data.column, 'Doing');
  assert.equal(data.order, 4);
});

test('an unordered card drops the order key rather than keeping a stale one', () => {
  const data = toFrontmatter(card({ order: undefined, data: { uuid: 'card-uuid', order: 7 } }));

  assert.equal('order' in data, false);
});

test('an assignee is trimmed, and a blank one drops the key', () => {
  assert.equal(toFrontmatter(card({ assignee: '  brandon  ' })).assignee, 'brandon');

  for (const assignee of [undefined, '', '   ']) {
    const data = toFrontmatter(card({ assignee, data: { uuid: 'card-uuid', assignee: 'old' } }));
    assert.equal('assignee' in data, false, `expected ${JSON.stringify(assignee)} to drop the key`);
  }
});

test('tags are written when present, and only kept empty when the file already had them', () => {
  assert.deepEqual(toFrontmatter(card({ tags: ['bug', 'ui'] })).tags, ['bug', 'ui']);

  // No tags and no existing key: stay out of the file entirely.
  assert.equal('tags' in toFrontmatter(card({ tags: [] })), false);

  // Had a tags key, now empty: keep it, so clearing tags is persisted rather than ignored.
  const cleared = toFrontmatter(card({ tags: [], data: { uuid: 'card-uuid', tags: ['bug'] } }));
  assert.deepEqual(cleared.tags, []);
});

test('attachments round trip, and the last one removed takes the key with it', () => {
  const attachment = { file: 'abc-note.pdf', name: 'note.pdf', type: 'application/pdf' };
  const written = toFrontmatter(card({ attachments: [attachment] }));
  assert.deepEqual(written.attachments, [attachment]);

  const emptied = toFrontmatter(
    card({ attachments: [], data: { uuid: 'card-uuid', attachments: [attachment] } }),
  );
  assert.equal('attachments' in emptied, false);
});

test('attachment entries are copied, not aliased into the card', () => {
  const attachment = { file: 'abc-note.pdf', name: 'note.pdf', type: 'application/pdf' };
  const source = card({ attachments: [attachment] });

  const data = toFrontmatter(source);
  (data.attachments as Array<{ name: string }>)[0].name = 'tampered.pdf';

  assert.equal(source.attachments[0].name, 'note.pdf');
});

test('the card and its retained metadata are never mutated', () => {
  const source = card({
    title: 'Renamed',
    assignee: '  brandon  ',
    tags: ['bug'],
    order: 3,
    data: { uuid: 'card-uuid', title: 'Stale', column: 'Elsewhere', order: 9 },
  });
  const before = structuredClone(source);

  toFrontmatter(source);

  assert.deepEqual(source, before);
});

test('an archive token splits back into its directory and filename', () => {
  assert.deepEqual(splitToken({ key: 'archive/2026-09/my-card.md' }), {
    dir: 'archive/2026-09',
    name: 'my-card.md',
  });
  // Filenames may contain anything but a slash, so only the last one separates.
  assert.deepEqual(splitToken({ key: 'archive/2026-09/a-b-1.md' }), {
    dir: 'archive/2026-09',
    name: 'a-b-1.md',
  });
});
