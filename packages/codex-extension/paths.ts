import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function codexHome(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return resolve(environment.CODEX_HOME || resolve(home, '.codex'));
}
