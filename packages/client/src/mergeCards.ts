import type { Card } from './fs/board';

export function mergedContent(
  destination: Pick<Card, 'body' | 'tags'>,
  source: Pick<Card, 'body' | 'tags'>,
): Pick<Card, 'body' | 'tags'> {
  return {
    body: [destination.body.trimEnd(), source.body.trim()].filter(Boolean).join('\n\n'),
    tags: [...new Set([...destination.tags, ...source.tags])],
  };
}
