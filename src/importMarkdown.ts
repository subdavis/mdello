export interface MarkdownImport {
  title: string;
  body: string;
}

const FIRST_LINE_HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/;

/** Converts a standalone Markdown document into mdello's title + body card model. */
export function parseMarkdownImport(filename: string, text: string): MarkdownImport {
  const firstBreak = text.indexOf('\n');
  const firstLine = (firstBreak === -1 ? text : text.slice(0, firstBreak)).replace(
    /^\uFEFF|\r$/g,
    '',
  );
  const heading = FIRST_LINE_HEADING.exec(firstLine);
  const fallback = filename.replace(/\.md$/i, '') || 'Imported card';

  if (!heading) return { title: fallback, body: text };

  const title = heading[1].replace(/[ \t]+#+[ \t]*$/, '').trim() || fallback;
  return { title, body: firstBreak === -1 ? '' : text.slice(firstBreak + 1) };
}
