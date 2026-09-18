import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';

export async function discoverExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const path = environment.PATH;
  if (!path) return undefined;

  for (const directory of path.split(delimiter)) {
    const candidate = resolve(directory || '.', name);
    try {
      const metadata = await stat(candidate);
      if (!metadata.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH when an entry is missing or not executable.
    }
  }

  return undefined;
}
