#!/usr/bin/env -S node --experimental-strip-types

import { resolve } from 'node:path';
import { backfillAssociations } from './backfill.ts';
import { DEFAULT_CONFIG_FILE, loadBoards } from './boards.ts';
import { type Integration, installIntegrations, uninstallIntegrations } from './install.ts';
import {
  createCompanionServer,
  DEFAULT_DATA_FILE,
  loadAssociationEvents,
  purgeAssociations,
} from './server.ts';

const command = process.argv[2] ?? 'serve';
const dataFile = resolve(process.env.MDELLO_COMPANION_DATA ?? DEFAULT_DATA_FILE);
const configFile = resolve(process.env.MDELLO_COMPANION_CONFIG ?? DEFAULT_CONFIG_FILE);

function fail(usage: string): void {
  console.error(`Usage: mdello-companion ${usage}`);
  process.exitCode = 1;
}

function integrationArgument(value: string | undefined): Integration | undefined | null {
  if (value === undefined) return undefined;
  if (value === 'macos' || value === 'pi' || value === 'claude') return value;
  return null;
}

switch (command) {
  case 'backfill': {
    const boardRoot = process.argv[3];
    if (!boardRoot) {
      fail('backfill /Path/to/board');
      break;
    }
    const result = await backfillAssociations({ boardRoot, dataFile, configFile });
    console.log(
      [
        `Scanned ${result.scannedSessions} Pi sessions (maximum 30-day lookback).`,
        `Found ${result.foundAssociations} associations in ${result.matchedSessions} sessions.`,
        `Added ${result.addedAssociations}; ${result.existingAssociations} already existed; purged ${result.purgedAssociations} stale.`,
      ].join(' '),
    );
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
      fail(`${command} [macos|pi|claude]`);
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
    const port = Number(process.env.MDELLO_COMPANION_PORT ?? 31337);
    const { url } = await createCompanionServer({ port, dataFile, configFile });
    console.log(`Mdello companion listening at ${url}`);
    break;
  }
  default:
    fail(
      '[serve|backfill /Path/to/board|status|purge|install [macos|pi|claude]|uninstall [macos|pi|claude]]',
    );
}
