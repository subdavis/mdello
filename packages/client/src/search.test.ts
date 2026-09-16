import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card } from './fs/board.ts';
import { searchCards, searchCardsAsync } from './search.ts';

function card(overrides: Partial<Card> & Pick<Card, 'id' | 'title'>): Card {
  return {
    uuid: overrides.id,
    name: `${overrides.title.toLocaleLowerCase().replaceAll(' ', '-')}.md`,
    column: 'Todo',
    tags: [],
    modified: 0,
    body: '',
    attachments: [],
    references: [],
    data: { title: overrides.title, column: 'Todo', tags: [] },
    ...overrides,
  };
}

const options = { caseSensitive: false, regex: false };

test('searches titles, filenames, frontmatter, and body lines', () => {
  const cards = [
    card({ id: 'title', title: 'Search feature' }),
    card({ id: 'filename', title: 'Filename', name: 'search-notes.md' }),
    card({ id: 'metadata', title: 'Metadata', data: { title: 'Metadata', owner: 'search-team' } }),
    card({ id: 'body', title: 'Body', body: 'first line\ncontains search here' }),
  ];

  const response = searchCards(cards, 'search', options);

  assert.deepEqual(
    response.results.map((result) => result.card.id),
    ['title', 'filename', 'metadata', 'body'],
  );
  assert.equal(response.results[3]?.matches[0]?.line, 2);
  assert.deepEqual(response.results[0]?.matches[0]?.ranges, [{ start: 0, end: 6 }]);
});

test('ranks exact and prefix title matches above other matches', () => {
  const cards = [
    card({ id: 'body', title: 'Unrelated', body: 'search search search' }),
    card({ id: 'contains', title: 'Board search tools' }),
    card({ id: 'prefix', title: 'Search tools' }),
    card({ id: 'exact', title: 'search' }),
  ];

  assert.deepEqual(
    searchCards(cards, 'search', options).results.map((result) => result.card.id),
    ['exact', 'prefix', 'contains', 'body'],
  );
});

test('supports case-sensitive and regular expression searches', () => {
  const cards = [card({ id: 'one', title: 'Search SEARCH', body: 'search-123' })];

  const sensitive = searchCards(cards, 'SEARCH', { caseSensitive: true, regex: false });
  assert.deepEqual(sensitive.results[0]?.matches[0]?.ranges, [{ start: 7, end: 13 }]);

  const regex = searchCards(cards, 'search-\\d+', { caseSensitive: false, regex: true });
  assert.equal(regex.results[0]?.matches.at(-1)?.text, 'search-123');
});

test('async search yields to pending input work and supports cancellation', async () => {
  const cards = Array.from({ length: 20 }, (_, index) =>
    card({ id: String(index), title: `Search ${index}` }),
  );
  const controller = new AbortController();
  let pendingWorkRan = false;
  setTimeout(() => {
    pendingWorkRan = true;
    controller.abort();
  }, 0);

  const response = await searchCardsAsync(cards, 'search', options, {
    signal: controller.signal,
    yieldEvery: 1,
  });

  assert.equal(pendingWorkRan, true);
  assert.deepEqual(response.results, []);
});

test('returns an error for invalid regular expressions', () => {
  const response = searchCards([card({ id: 'one', title: 'One' })], '[', {
    caseSensitive: false,
    regex: true,
  });

  assert.equal(response.results.length, 0);
  assert.match(response.error ?? '', /regular expression/i);
});
