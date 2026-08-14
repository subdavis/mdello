import MarkdownIt from 'markdown-it';

// html: false keeps raw HTML out of card bodies, so no sanitizer is needed.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

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
