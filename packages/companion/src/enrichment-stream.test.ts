import assert from 'node:assert/strict';
import test from 'node:test';
import { type EnrichmentProvider, enrichmentUrls } from './enrichment-stream.ts';

function provider(name: string, host: string): EnrichmentProvider {
  return {
    name,
    supports: (url) => new URL(url).hostname === host,
    refresh: async () => undefined,
  };
}

test('accepts and deduplicates URLs across registered enrichment providers', () => {
  const providers = [provider('first', 'first.example'), provider('second', 'second.example')];
  const first = 'https://first.example/item/1';
  const second = 'https://second.example/item/2';
  const request = new URL('http://localhost/enrichments');
  request.searchParams.append('url', first);
  request.searchParams.append('url', second);
  request.searchParams.append('url', first);

  assert.deepEqual(enrichmentUrls(request, providers), [first, second]);

  request.searchParams.append('url', 'https://unsupported.example/item/3');
  assert.equal(enrichmentUrls(request, providers), undefined);
});
