export interface GroupedColumn<T> {
  name: string;
  cards: T[];
  virtual: boolean;
}

/** Groups every card, prepending stable virtual columns for names absent from config. */
export function groupColumns<T extends { column: string }>(
  cards: T[],
  columnNames: string[],
): GroupedColumn<T>[] {
  const configured = columnNames.map((name) => ({
    name,
    cards: [] as T[],
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
