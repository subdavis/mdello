import assert from 'node:assert/strict';
import test from 'node:test';
import { type SearchDoc, SearchIndex } from './engine.ts';

function doc(id: string, title: string, body = '', fields: SearchDoc['fields'] = []): SearchDoc {
  return { id, title, body, fields };
}

const plain = { caseSensitive: false, regex: false };

function indexOf(...docs: SearchDoc[]): SearchIndex {
  const index = new SearchIndex();
  index.upsert(docs);
  return index;
}

test('ranks exact title, prefix title, contained title, frontmatter, then body', () => {
  const index = indexOf(
    doc('body', 'Unrelated', 'search search search'),
    doc('field', 'Other', '', [['owner', 'search-team']]),
    doc('contains', 'Board search'),
    doc('prefix', 'Search tools'),
    doc('exact', 'search'),
  );
  assert.deepEqual(
    index.search('search', plain).results.map((r) => r.id),
    ['exact', 'prefix', 'contains', 'field', 'body'],
  );
});

test('returns body snippets with ranges relative to the snippet', () => {
  const long = `${'x'.repeat(200)} needle tail`;
  const [result] = indexOf(doc('a', 'A', `first\n   ${long}`)).search('NEEDLE', plain).results;
  const [match] = result?.matches ?? [];
  assert.ok(match);
  assert.equal(match.field, undefined);
  assert.ok(match.snippet.startsWith('…'));
  const range = match.ranges[0];
  assert.ok(range);
  assert.equal(match.snippet.slice(range.start, range.end), 'needle');
});

test('keeps short lines whole', () => {
  const text = 'the quick brown fox jumps over the lazy needle';
  const [result] = indexOf(doc('a', 'A', text)).search('needle', plain).results;
  assert.equal(result?.matches[0]?.snippet, text);
});

test('frontmatter matches carry their key and title ranges are reported', () => {
  const [result] = indexOf(doc('a', 'Find me', '', [['tags', 'find, other']])).search(
    'find',
    plain,
  ).results;
  assert.deepEqual(result?.titleRanges, [{ start: 0, end: 4 }]);
  assert.equal(result?.matches[0]?.field, 'tags');
  assert.equal(result?.count, 2);
});

test('case sensitivity and regex toggles', () => {
  const index = indexOf(doc('a', 'Search SEARCH', 'ticket-123'));
  const sensitive = index.search('SEARCH', { caseSensitive: true, regex: false });
  assert.deepEqual(sensitive.results[0]?.titleRanges, [{ start: 7, end: 13 }]);

  const regex = index.search('ticket-\\d+', { caseSensitive: false, regex: true });
  assert.equal(regex.results[0]?.matches[0]?.snippet, 'ticket-123');

  const invalid = index.search('[', { caseSensitive: false, regex: true });
  assert.deepEqual(invalid.results, []);
  assert.ok(invalid.error);
});

test('upsert replaces and remove drops entries', () => {
  const index = indexOf(doc('a', 'alpha'));
  index.upsert([doc('a', 'beta')]);
  assert.equal(index.search('alpha', plain).results.length, 0);
  assert.equal(index.search('beta', plain).results.length, 1);
  index.remove(['a']);
  assert.equal(index.search('beta', plain).results.length, 0);
});

test('caps stored snippets at 200 per card while counting all plain and regex hits', () => {
  const body = Array.from({ length: 250 }, (_, i) => (i % 2 === 0 ? 'hit\n' : 'hit hit')).join(
    '\n',
  );
  const index = indexOf(doc('a', 'Title', body, [['empty', '']]));

  const textResult = index.search('hit', plain).results[0];
  assert.equal(textResult?.matches.length, 200);
  assert.equal(textResult?.count, 375);

  const regexResult = index.search('h.t', { caseSensitive: false, regex: true }).results[0];
  assert.equal(regexResult?.matches.length, 200);
  assert.equal(regexResult?.count, 375);
});
