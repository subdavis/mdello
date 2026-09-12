#!/usr/bin/env -S node --experimental-strip-types

import { backfillAssociations } from './backfill.ts';
import { createCompanionServer, resetAssociations } from './server.ts';

const command = process.argv[2] ?? 'serve';

if (command === 'backfill') {
  const result = await backfillAssociations();
  console.log(
    [
      `Scanned ${result.scannedSessions} Pi sessions.`,
      `Found ${result.foundAssociations} associations in ${result.matchedSessions} sessions.`,
      `Added ${result.addedAssociations}; ${result.existingAssociations} already existed.`,
    ].join(' '),
  );
} else if (command === 'reset') {
  await resetAssociations();
  console.log('Reset companion session data.');
} else if (command === 'serve') {
  const port = Number(process.env.MDELLO_COMPANION_PORT ?? 31337);
  const { url } = await createCompanionServer({ port });
  console.log(`Mdello companion listening at ${url}`);
} else {
  console.error('Usage: companion [serve|backfill|reset]');
  process.exitCode = 1;
}
