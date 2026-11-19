export type ReferenceKind = 'git' | 'jira' | 'slack' | 'figma' | 'google-docs';

export interface ReferenceLink {
  kind: ReferenceKind;
  label: string;
  url: string;
}

/** Kinds that only ever contribute a single chip, since their labels carry no detail. */
const SINGLETONS: ReferenceKind[] = ['slack', 'figma', 'google-docs'];

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;

const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/;
const GITLAB =
  /^https?:\/\/[^/]*gitlab[^/]*\/(?:[^/]+\/)*([^/]+)\/-\/(?:merge_requests|issues)\/(\d+)/;
const JIRA = /^https?:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+)/;
const SLACK = /^https?:\/\/[^/]+\.slack\.com\/archives\//;
const FIGMA = /^https?:\/\/(?:www\.)?figma\.com\//;
const GOOGLE_DOCS = /^https?:\/\/docs\.google\.com\/document\//;

function classify(url: string): ReferenceLink | null {
  // Git and Jira URLs are trimmed to the item itself so comment/file links collapse into it.
  const git = GITHUB.exec(url) ?? GITLAB.exec(url);
  if (git) return { kind: 'git', label: `${git[1]}#${git[2]}`, url: git[0] };

  const jira = JIRA.exec(url);
  if (jira) return { kind: 'jira', label: jira[1], url: jira[0] };

  if (SLACK.test(url)) return { kind: 'slack', label: 'Slack', url };
  if (FIGMA.test(url)) return { kind: 'figma', label: 'Figma', url };
  if (GOOGLE_DOCS.test(url)) return { kind: 'google-docs', label: 'Google Docs', url };

  return null;
}

/** External references found in a card body, in order of discovery. */
export function findReferenceLinks(body: string): ReferenceLink[] {
  const found: ReferenceLink[] = [];

  for (const match of body.matchAll(URL_PATTERN)) {
    // Trailing punctuation is prose, not part of the link.
    const reference = classify(match[0].replace(/[.,;:!?]+$/, ''));
    if (!reference) continue;

    const duplicate = found.some(
      (existing) =>
        existing.url === reference.url ||
        (existing.kind === reference.kind && SINGLETONS.includes(reference.kind)),
    );
    if (!duplicate) found.push(reference);
  }

  return found;
}
