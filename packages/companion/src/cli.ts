#!/usr/bin/env -S node --experimental-strip-types

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  BACKFILL_HARNESSES,
  BACKFILL_SOURCES,
  backfillAssociations,
  isBackfillHarness,
} from './backfill.ts';
import { DEFAULT_CONFIG_FILE, loadBoards } from './boards.ts';
import {
  INTEGRATIONS,
  type Integration,
  installIntegrations,
  isIntegration,
  uninstallIntegrations,
} from './install.ts';
import {
  createCompanionServer,
  DEFAULT_DATA_FILE,
  DEFAULT_PORT,
  isCompanionListening,
  loadAssociationEvents,
  purgeAssociations,
} from './server.ts';

const command = process.argv[2] ?? 'serve';
const dataFile = resolve(process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE);
const configFile = resolve(process.env.MDELLO_COMPANION_CONFIG ?? DEFAULT_CONFIG_FILE);
const port = Number(process.env.MDELLO_COMPANION_PORT ?? DEFAULT_PORT);
const harnessList = BACKFILL_HARNESSES.join('|');
const integrationList = INTEGRATIONS.join('|');

function fail(usage: string): void {
  console.error(`Usage: mdello-companion ${usage}`);
  console.error('Run "mdello-companion help" for every command.');
  process.exitCode = 1;
}

/** Two aligned columns, sized to the widest label so the help text stays scannable. */
function columns(entries: [label: string, detail: string][]): string[] {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, detail]) => `  ${label.padEnd(width)}  ${detail}`);
}

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function helpText(): string {
  return [
    'mdello-companion links agent sessions to the board cards they touch.',
    '',
    'Usage',
    '  mdello-companion <command> [argument]',
    '',
    'Commands',
    ...columns([
      ['serve', 'Start the sidecar and receive harness hooks (default command)'],
      ['status', 'List tracked boards and their event counts'],
      [`backfill [${harnessList}]`, 'Rebuild associations from stored sessions, then exit'],
      ['purge', 'Clear association history (alias: reset)'],
      [`install [${integrationList}]`, 'Install the launch agent and harness hooks'],
      [`uninstall [${integrationList}]`, 'Remove the launch agent and harness hooks'],
      ['help', 'Show this message (aliases: -h, --help)'],
    ]),
    '',
    '  An omitted bracketed argument means every harness or integration.',
    '',
    'Environment',
    ...columns([
      ['MDELLO_COMPANION_PORT', `Listen port (${DEFAULT_PORT})`],
      ['MDELLO_COMPANION_DATA', `Association log (${tilde(DEFAULT_DATA_FILE)})`],
      [
        'MDELLO_COMPANION_CONFIG',
        `Tracked boards + settings, e.g. webOrigin (${tilde(DEFAULT_CONFIG_FILE)})`,
      ],
      ...BACKFILL_SOURCES.map(({ harness, envVar, sessionsRoot }): [string, string] => [
        envVar,
        `${harness} sessions read by backfill (${tilde(sessionsRoot)})`,
      ]),
      ['DEBUG', 'Set to 1 for structured stderr logs'],
    ]),
  ].join('\n');
}

function integrationArgument(value: string | undefined): Integration | undefined | null {
  if (value === undefined) return undefined;
  return isIntegration(value) ? value : null;
}

/** No argument means every harness, matching `install`. An unknown one is a usage error. */
function harnessArgument(value: string | undefined): string[] | null {
  if (value === undefined) return BACKFILL_HARNESSES;
  return isBackfillHarness(value) ? [value] : null;
}

switch (command) {
  case 'backfill': {
    const harnesses = harnessArgument(process.argv[3]);
    if (!harnesses || process.argv[4]) {
      fail(`backfill [${harnessList}]`);
      break;
    }
    if (await isCompanionListening(port)) {
      console.error(
        `A companion is listening on port ${port}. Stop it first: backfill rewrites ${dataFile}, and a running companion would overwrite the result from memory.`,
      );
      process.exitCode = 1;
      break;
    }

    for (const harness of harnesses) {
      const result = await backfillAssociations({ harness, dataFile, configFile });
      console.log(
        [
          `${harness}: scanned ${result.scannedSessions} sessions (maximum 30-day lookback).`,
          `Found ${result.foundAssociations} associations in ${result.matchedSessions} sessions.`,
          `Added ${result.addedAssociations}; ${result.existingAssociations} already existed; purged ${result.purgedAssociations} stale.`,
        ].join(' '),
      );
    }
    break;
  }
  case 'status': {
    const [boards, events] = await Promise.all([
      loadBoards(configFile),
      loadAssociationEvents(dataFile),
    ]);
    if (boards.length === 0) console.log('No tracked boards.');
    const counts = new Map<string, number>();
    for (const event of events) {
      if (event.boardUuid) counts.set(event.boardUuid, (counts.get(event.boardUuid) ?? 0) + 1);
    }
    for (const board of boards) {
      console.log(`${board.uuid} ${board.path}: ${counts.get(board.uuid) ?? 0} events`);
    }
    break;
  }
  case 'purge':
  case 'reset': {
    await purgeAssociations(dataFile);
    console.log('Purged companion session data.');
    break;
  }
  case 'install':
  case 'uninstall': {
    const integration = integrationArgument(process.argv[3]);
    if (integration === null || process.argv[4]) {
      fail(`${command} [${integrationList}]`);
      break;
    }
    const messages =
      command === 'install'
        ? await installIntegrations(integration)
        : await uninstallIntegrations(integration);
    console.log(messages.join('\n'));
    break;
  }
  case 'serve': {
    const { url } = await createCompanionServer({ port, dataFile, configFile });
    console.log(`Mdello companion listening at ${url}`);
    break;
  }
  case 'help':
  case '-h':
  case '--help':
    console.log(helpText());
    break;
  default:
    console.error(`Unknown command "${command}".\n\n${helpText()}`);
    process.exitCode = 1;
}
