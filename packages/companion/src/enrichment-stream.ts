import type { IncomingMessage, ServerResponse } from 'node:http';

export const ENRICHMENT_POLL_INTERVAL_MS = 30_000;
export const MAX_ENRICHMENT_URLS = 50;

export interface UrlEnrichment {
  provider: string;
  url: string;
}

export interface UrlEnrichmentResult {
  items: UrlEnrichment[];
  errors: Array<{ url: string; provider: string; error: 'lookup_failed' }>;
}

export interface EnrichmentProvider {
  name: string;
  supports: (url: string) => boolean;
  refresh: (urls: string[], onResult: (result: UrlEnrichmentResult) => void) => Promise<void>;
}

export interface EnrichmentStreamContext {
  cache: Map<string, UrlEnrichment>;
  clients?: Set<ServerResponse>;
  pollIntervalMs?: number;
  providers: EnrichmentProvider[];
}

function writeEvent(response: ServerResponse, result: UrlEnrichmentResult): void {
  response.write(`event: enrichments\ndata: ${JSON.stringify(result)}\n\n`);
}

function providerFor(url: string, providers: EnrichmentProvider[]): EnrichmentProvider | undefined {
  return providers.find((provider) => provider.supports(url));
}

export function enrichmentUrls(url: URL, providers: EnrichmentProvider[]): string[] | undefined {
  const urls = [...new Set(url.searchParams.getAll('url'))];
  if (urls.length === 0 || urls.length > MAX_ENRICHMENT_URLS) return undefined;
  return urls.every((value) => providerFor(value, providers)) ? urls : undefined;
}

function urlsByProvider(
  urls: string[],
  providers: EnrichmentProvider[],
): Map<EnrichmentProvider, string[]> {
  const grouped = new Map<EnrichmentProvider, string[]>();
  for (const url of urls) {
    const provider = providerFor(url, providers);
    if (provider) grouped.set(provider, [...(grouped.get(provider) ?? []), url]);
  }
  return grouped;
}

export function handleEnrichmentStream(
  request: IncomingMessage,
  response: ServerResponse,
  urls: string[],
  context: EnrichmentStreamContext,
): void {
  const { cache, clients, providers } = context;
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });

  clients?.add(response);
  writeEvent(response, {
    items: urls.flatMap((url) => {
      const item = cache.get(url);
      return item ? [item] : [];
    }),
    errors: [],
  });

  let closed = false;
  let refreshing = false;
  const publish = (result: UrlEnrichmentResult): void => {
    for (const item of result.items) cache.set(item.url, item);
    if (!closed) writeEvent(response, result);
  };
  const refresh = async (): Promise<void> => {
    if (closed || refreshing) return;
    refreshing = true;
    const grouped = urlsByProvider(urls, providers);
    await Promise.all(
      [...grouped].map(async ([provider, providerUrls]) => {
        try {
          await provider.refresh(providerUrls, publish);
        } catch {
          publish({
            items: [],
            errors: providerUrls.map((url) => ({
              url,
              provider: provider.name,
              error: 'lookup_failed',
            })),
          });
        }
      }),
    );
    refreshing = false;
  };

  void refresh();
  const timer = setInterval(
    () => void refresh(),
    context.pollIntervalMs ?? ENRICHMENT_POLL_INTERVAL_MS,
  );
  request.once('close', () => {
    closed = true;
    clearInterval(timer);
    clients?.delete(response);
  });
}
