import jiraIcon from './assets/icons/atlassian-jira-icon.svg';
import figmaIcon from './assets/icons/Figma-logo.svg';
import gitIcon from './assets/icons/Octicons-mark-github.svg';
import slackIcon from './assets/icons/Slack_icon_2019.svg';

export type ReferenceKind = 'git' | 'jira' | 'slack' | 'figma';

export interface Reference {
  kind: ReferenceKind;
  label: string;
  url: string;
  icon: string;
}

export const REFERENCE_ICONS: Record<ReferenceKind, string> = {
  git: gitIcon,
  jira: jiraIcon,
  slack: slackIcon,
  figma: figmaIcon,
};

/** Kinds that only ever contribute a single chip, since their labels carry no detail. */
const SINGLETONS: ReferenceKind[] = ['slack', 'figma'];

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;

const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/;
const GITLAB =
  /^https?:\/\/[^/]*gitlab[^/]*\/(?:[^/]+\/)*([^/]+)\/-\/(?:merge_requests|issues)\/(\d+)/;
const JIRA = /^https?:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+)/;
const SLACK = /^https?:\/\/[^/]+\.slack\.com\/archives\//;
const FIGMA = /^https?:\/\/(?:www\.)?figma\.com\//;

type Match = Omit<Reference, 'icon'>;

function classify(url: string): Match | null {
  const git = GITHUB.exec(url) ?? GITLAB.exec(url);
  if (git) return { kind: 'git', label: `${git[1]}#${git[2]}`, url };

  const jira = JIRA.exec(url);
  if (jira) return { kind: 'jira', label: jira[1], url };

  if (SLACK.test(url)) return { kind: 'slack', label: 'Slack', url };
  if (FIGMA.test(url)) return { kind: 'figma', label: 'Figma', url };

  return null;
}

/** External references found in a card body, in order of discovery. */
export function findReferences(body: string): Reference[] {
  const found: Reference[] = [];

  for (const match of body.matchAll(URL_PATTERN)) {
    // Trailing punctuation is prose, not part of the link.
    const reference = classify(match[0].replace(/[.,;:!?]+$/, ''));
    if (!reference) continue;

    const duplicate = found.some(
      (existing) =>
        existing.url === reference.url ||
        (existing.kind === reference.kind && SINGLETONS.includes(reference.kind)),
    );
    if (duplicate) continue;

    found.push({ ...reference, icon: REFERENCE_ICONS[reference.kind] });
  }

  return found;
}
