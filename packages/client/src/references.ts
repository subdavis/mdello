import jiraIcon from './assets/icons/atlassian-jira-icon.svg';
import figmaIcon from './assets/icons/Figma-logo.svg';
import googleDocsIcon from './assets/icons/Google-Docs-logo.svg';
import gitIcon from './assets/icons/Octicons-mark-github.svg';
import slackIcon from './assets/icons/Slack_icon_2019.svg';

import { findReferenceLinks, type ReferenceKind, type ReferenceLink } from './referenceLinks';

export type { ReferenceKind };

export interface Reference extends ReferenceLink {
  icon: string;
}

export type GitHubLinkStatus = 'open' | 'closed' | 'merged' | 'draft';
export type GitHubCiStatus = 'passing' | 'failing' | 'pending' | 'none';
export type GitHubReviewStatus = 'approved' | 'required' | 'changes';

export interface GitHubLinkDetails {
  url: string;
  number: number;
  title: string;
  status: GitHubLinkStatus;
  ciStatus?: GitHubCiStatus;
  ciChecks?: { completed: number; total: number };
  reviewStatus?: GitHubReviewStatus;
  additions?: number;
  deletions?: number;
}

export interface JiraLinkDetails {
  url: string;
  key: string;
  title: string;
  status: string;
}

export const REFERENCE_ICONS: Record<ReferenceKind, string> = {
  git: gitIcon,
  jira: jiraIcon,
  slack: slackIcon,
  figma: figmaIcon,
  'google-docs': googleDocsIcon,
};

/** External references found in a card body, in order of discovery. */
export function findReferences(body: string): Reference[] {
  return findReferenceLinks(body).map((link) => ({ ...link, icon: REFERENCE_ICONS[link.kind] }));
}
