import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { companionPaths } from './xdg.ts';

test('uses XDG config and state roots for companion files', () => {
  assert.deepEqual(
    companionPaths({ XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state' }, '/home/user'),
    {
      configDirectory: '/xdg/config/mdello',
      stateDirectory: '/xdg/state/mdello',
      configFile: '/xdg/config/mdello/companion.json',
      dataFile: '/xdg/state/mdello/companion.jsonl',
      stdoutLog: '/xdg/state/mdello/companion.log',
      stderrLog: '/xdg/state/mdello/companion-error.log',
    },
  );
});

test('falls back for missing, empty, or relative XDG roots', () => {
  const home = '/home/user';
  const paths = companionPaths({ XDG_CONFIG_HOME: '', XDG_STATE_HOME: 'relative/state' }, home);

  assert.equal(paths.configFile, join(home, '.config/mdello/companion.json'));
  assert.equal(paths.dataFile, join(home, '.local/state/mdello/companion.jsonl'));
});
