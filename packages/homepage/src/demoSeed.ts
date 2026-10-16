import type { MemorySeed } from '@client/board/stores/memoryBoardStore';

/**
 * Whatever a visitor drags around lives here and nowhere else — a refresh restores all of it.
 * Deliberately hand-written rather than read from `demo-board/`: the marketing page should not
 * depend on a folder that exists for exercising the real filesystem backend.
 */
/** Shared with the homepage so the "one file per card" section can open this exact card. */
export const GUIDE_CARD_UUID = '550e8400-e29b-41d4-a716-446655440000';

export const demoSeed: MemorySeed = {
  settings: {
    columns: ['Backlog', 'In progress', 'Done'],
    labels: [
      { name: 'writing', color: '#0c66e4' },
      { name: 'chore', color: '#6b778c' },
      { name: 'idea', color: '#8250df' },
    ],
  },
  cards: [
    {
      title: 'Drag this card somewhere else',
      column: 'Backlog',
      order: 1,
      tags: ['idea'],
      body: 'Every card is one markdown file. Moving it between columns rewrites a single\n`column:` line in its frontmatter — the file never moves.',
    },
    {
      title: 'Rename a column',
      column: 'Backlog',
      order: 2,
      tags: ['chore'],
      body: 'Double-click a column header. The new name is written to `mdello.yml`, and every\ncard in that column is updated to match.',
    },
    {
      title: 'Cards are just text',
      column: 'Backlog',
      order: 3,
      body: 'Open this one and you get a markdown editor.\n\n- lists work\n- so does `code`\n- and [links](https://github.com)\n\nKeys the app does not recognise are left alone, so you can keep your own frontmatter.',
    },
    /*
     * The card the "one file per card" section opens. Its uuid and created stamp are pinned
     * because the code sample beside it is that same file written out by hand — if these
     * drift, the section stops being true.
     */
    {
      uuid: GUIDE_CARD_UUID,
      title: 'Write the getting-started guide',
      column: 'In progress',
      order: 1,
      tags: ['writing'],
      assignee: 'you',
      created: '2026-09-20T14:52:58.000Z',
      body: 'Cover the three things people get stuck on:\n\n- picking a folder, and why `~/.local/state` works\n- what belongs in `mdello.yml`\n- what happens when two tabs open one board\n\nLink the [support table](https://caniuse.com/filesystem)\nso nobody finds out the hard way.',
    },
    {
      title: 'Archive something',
      column: 'In progress',
      order: 2,
      body: 'Drag a card onto the archive target at the end of the board. Undo is offered for a few\nseconds; on a real board the file moves into `archive/YYYY-MM/`.',
    },
    {
      title: 'Works offline, forever',
      column: 'Done',
      order: 1,
      tags: ['idea'],
      body: 'No server means nothing to go down, nothing to pay for, and nothing to migrate off\nwhen you get bored of it.',
    },
  ],
};
