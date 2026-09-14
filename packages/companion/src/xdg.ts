import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface CompanionPaths {
  configDirectory: string;
  stateDirectory: string;
  configFile: string;
  dataFile: string;
  stdoutLog: string;
  stderrLog: string;
}

function xdgRoot(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback;
}

export function companionPaths(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): CompanionPaths {
  const configDirectory = join(
    xdgRoot(environment.XDG_CONFIG_HOME, join(home, '.config')),
    'mdello',
  );
  const stateDirectory = join(
    xdgRoot(environment.XDG_STATE_HOME, join(home, '.local/state')),
    'mdello',
  );

  return {
    configDirectory,
    stateDirectory,
    configFile: join(configDirectory, 'companion.json'),
    dataFile: join(stateDirectory, 'companion.jsonl'),
    stdoutLog: join(stateDirectory, 'companion.log'),
    stderrLog: join(stateDirectory, 'companion-error.log'),
  };
}
