import type { Frontmatter } from '@mdello/common/frontmatter';
import type { ArchiveToken, Card } from '../../types/board.ts';

/**
 * The single place domain fields become Markdown frontmatter. Unknown keys survive because
 * the card's retained `data` is the base; every field the board owns is written over the top.
 *
 * The absence rules live here rather than in the controller, because they are facts about the
 * file format and not about boards: a blank assignee drops its key instead of writing an empty
 * string, and `tags` is only emitted when the card has some or the file already had the key.
 *
 * Deliberately free of runtime imports so it can be tested without a module loader, and pure
 * so that `saveCard`'s `Readonly<Card>` promise is real: the input is never touched.
 */
export function toFrontmatter(card: Readonly<Card>): Frontmatter {
  const data: Frontmatter = { ...card.data };

  data.title = card.title;
  data.column = card.column;

  if (card.order === undefined) delete data.order;
  else data.order = card.order;

  // Trimmed here too, not just in the controller: ordering and column renames write cards
  // straight through without going past the controller's input normalization.
  const assignee = card.assignee?.trim();
  if (assignee) data.assignee = assignee;
  else delete data.assignee;

  if (card.tags.length || 'tags' in card.data) data.tags = [...card.tags];

  if (card.attachments.length) {
    data.attachments = card.attachments.map((attachment) => ({ ...attachment }));
  } else {
    delete data.attachments;
  }

  return data;
}

/** `archive/2026-09/card.md` -> the directory and filename `unarchiveCard` wants. */
export function splitToken(token: ArchiveToken): { dir: string; name: string } {
  const cut = token.key.lastIndexOf('/');
  return { dir: token.key.slice(0, cut), name: token.key.slice(cut + 1) };
}
