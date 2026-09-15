import MarkdownIt from 'markdown-it';

// html: false keeps raw HTML out of card bodies, so no sanitizer is needed.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const TASK_MARKER = /^((?: {0,3}>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}\.)[ \t]+\[)([ xX])(\])/;

function sourceLines(source: string): string[] {
  return source.split(/\r\n|\n|\r/);
}

/** Toggle one rendered task marker without changing line endings or unrelated content. */
export function setTaskChecked(source: string, line: number, checked: boolean): string {
  if (!Number.isInteger(line) || line < 0) return source;

  let currentLine = 0;
  let lineStart = 0;
  while (currentLine < line) {
    const newline = /\r\n|\n|\r/g;
    newline.lastIndex = lineStart;
    const match = newline.exec(source);
    if (!match) return source;
    lineStart = newline.lastIndex;
    currentLine += 1;
  }

  const lineEndMatch = /\r\n|\n|\r/g;
  lineEndMatch.lastIndex = lineStart;
  const lineEnd = lineEndMatch.exec(source)?.index ?? source.length;
  const originalLine = source.slice(lineStart, lineEnd);
  const updatedLine = originalLine.replace(TASK_MARKER, `$1${checked ? 'x' : ' '}$3`);
  if (updatedLine === originalLine) return source;
  return source.slice(0, lineStart) + updatedLine + source.slice(lineEnd);
}

// Convert task markers only when they begin the first block in a list item.
md.core.ruler.after('inline', 'task_lists', (state) => {
  const lines = sourceLines(state.src);
  const listItems: Array<{ tokenIndex: number; inlineSeen: boolean }> = [];

  for (let index = 0; index < state.tokens.length; index += 1) {
    const token = state.tokens[index];
    if (token.type === 'list_item_open') {
      listItems.push({ tokenIndex: index, inlineSeen: false });
      continue;
    }
    if (token.type === 'list_item_close') {
      listItems.pop();
      continue;
    }
    if (token.type !== 'inline' || listItems.length === 0) continue;

    const item = listItems.at(-1);
    if (!item || item.inlineSeen) continue;
    item.inlineSeen = true;

    const line = token.map?.[0];
    const children = token.children;
    const first = children?.[0];
    if (
      line === undefined ||
      !children ||
      !TASK_MARKER.test(lines[line] ?? '') ||
      first?.type !== 'text'
    ) {
      continue;
    }

    const marker = /^\[([ xX])\](?:[ \t]+|$)/.exec(first.content);
    if (!marker) continue;

    const checkbox = new state.Token('task_checkbox', 'input', 0);
    checkbox.meta = { checked: marker[1].toLowerCase() === 'x', line };
    first.content = first.content.slice(marker[0].length);
    children.unshift(checkbox);
    state.tokens[item.tokenIndex].attrJoin('class', 'task-list-item');
  }
});

md.renderer.rules.task_checkbox = (tokens, idx) => {
  const { checked, line } = tokens[idx].meta as { checked: boolean; line: number };
  return `<input class="task-list-item-checkbox" type="checkbox" data-task-line="${line}" aria-label="Toggle task"${checked ? ' checked' : ''}>`;
};

// Keep link navigation outside the installed PWA.
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, idx, options);
};

// Tag block elements with their source line so the editor can jump there on double-click.
const renderToken = md.renderer.renderToken.bind(md.renderer);
md.renderer.renderToken = (tokens, idx, options) => {
  const token = tokens[idx];
  if (token.map && token.nesting !== -1) token.attrSet('data-line', String(token.map[0]));
  return renderToken(tokens, idx, options);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
