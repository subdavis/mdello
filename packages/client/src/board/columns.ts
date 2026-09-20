import type { Card, Column } from '../types/board';

/** Groups every card, prepending stable virtual columns for names absent from settings. */
export function groupColumns(cards: Card[], columnNames: string[]): Column[] {
  const configured: Column[] = columnNames.map((name) => ({
    name,
    cards: [],
    virtual: false,
  }));
  const byName = new Map(configured.map((column) => [column.name, column]));

  for (const card of cards) {
    let column = byName.get(card.column);
    if (!column) {
      column = { name: card.column, cards: [], virtual: true };
      byName.set(card.column, column);
    }
    column.cards.push(card);
  }

  const virtual = [...byName.values()]
    .filter((column) => column.virtual)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...virtual, ...configured];
}

/** Explicit order wins; unordered cards fall to the bottom, newest first. */
export function sortCards(cards: Card[]): void {
  cards.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      b.modified - a.modified,
  );
}

/** The one place a flat card list becomes the board's column layout, for every backend. */
export function buildColumns(cards: Card[], columnNames: string[]): Column[] {
  const columns = groupColumns(cards, columnNames);
  for (const column of columns) sortCards(column.cards);
  return columns;
}
