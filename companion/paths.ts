export function extractCardPaths(text: string, boardRoot: string): string[] {
  const escapedRoot = boardRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(`${escapedRoot}/[^\\n\\r"']+?\\.md`, 'g')) ?? [];
  return [...new Set(matches)];
}

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part
        ? [String(part.text)]
        : [],
    )
    .join('\n');
}
