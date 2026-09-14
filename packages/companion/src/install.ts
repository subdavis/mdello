import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  claudePluginFiles,
  HOOK_PATH,
  isCompanionPlugin,
  PLUGIN_NAME,
} from '@mdello/claude-extension';
import { type CompanionPaths, companionPaths } from './xdg.ts';

const exec = promisify(execFile);
const SERVICE_LABEL = 'com.mdello.companion';

export const INTEGRATIONS = ['macos', 'pi', 'claude'] as const;

export type Integration = (typeof INTEGRATIONS)[number];

export function isIntegration(value: unknown): value is Integration {
  return INTEGRATIONS.includes(value as Integration);
}

interface CommandResult {
  stdout: string;
}

interface InstallOptions {
  home?: string;
  platform?: NodeJS.Platform;
  repoRoot?: string;
  /** Absolute node binary embedded in the launch agent. Defaults to the installing interpreter. */
  nodePath?: string;
  /**
   * PATH embedded in the launch agent's environment. launchd does not source shell rc files, so
   * without this the sidecar can only see binaries under /usr/bin:/bin:/usr/sbin:/sbin — missing
   * anything installed under ~/.local/bin, Homebrew, mise, etc. that `herdr` or other CLIs need.
   * Defaults to the installing shell's PATH.
   */
  pathEnv?: string;
  uid?: number;
  /** Companion origin written into harness hook configuration. */
  endpoint?: string;
  /** Environment used to resolve XDG paths. Defaults to the installing process environment. */
  environment?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
}

function defaults(options: InstallOptions = {}) {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return {
    home: options.home ?? homedir(),
    platform: options.platform ?? process.platform,
    repoRoot,
    uid: options.uid ?? process.getuid?.() ?? 0,
    run: options.run ?? ((command: string, args: string[]) => exec(command, args)),
    nodePath: options.nodePath ?? process.execPath,
    pathEnv: options.pathEnv ?? process.env.PATH ?? '',
    environment: options.environment ?? process.env,
  };
}

async function pathKind(path: string): Promise<'missing' | 'symlink' | 'other'> {
  try {
    return (await lstat(path)).isSymbolicLink() ? 'symlink' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function migrateLegacyFile(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await rm(source);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EEXIST') throw error;
  }
}

async function migrateLegacyFiles(home: string, paths: CompanionPaths): Promise<void> {
  const legacyDirectory = join(home, '.mdello');
  await mkdir(paths.configDirectory, { recursive: true });
  await mkdir(paths.stateDirectory, { recursive: true });

  await migrateLegacyFile(join(legacyDirectory, 'companion.json'), paths.configFile);
  await migrateLegacyFile(join(legacyDirectory, 'companion.jsonl'), paths.dataFile);
  await migrateLegacyFile(join(legacyDirectory, 'companion.log'), paths.stdoutLog);
  await migrateLegacyFile(join(legacyDirectory, 'companion-error.log'), paths.stderrLog);

  try {
    await rmdir(legacyDirectory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function installMacOS(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  if (config.platform !== 'darwin') throw new Error('macOS installation requires macOS.');

  const nodePath = config.nodePath.trim();
  if (!isAbsolute(nodePath)) throw new Error(`Node path must be absolute, got ${nodePath}.`);
  try {
    await access(nodePath, constants.X_OK);
  } catch {
    throw new Error(`Node binary at ${nodePath} is missing or not executable.`);
  }

  const templatePath = join(config.repoRoot, 'packages/companion/com.mdello.companion.plist');
  const destination = join(config.home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
  const temporary = `${destination}.tmp-${process.pid}`;
  const paths = companionPaths(config.environment, config.home);
  const template = await readFile(templatePath, 'utf8');
  const plist = template
    .replaceAll('__NODE_BIN__', xmlEscape(nodePath))
    .replaceAll('__MDELLO_ROOT__', xmlEscape(config.repoRoot))
    .replaceAll('__HOME__', xmlEscape(config.home))
    .replaceAll('__XDG_CONFIG_HOME__', xmlEscape(dirname(paths.configDirectory)))
    .replaceAll('__XDG_STATE_HOME__', xmlEscape(dirname(paths.stateDirectory)))
    .replaceAll('__COMPANION_STDOUT__', xmlEscape(paths.stdoutLog))
    .replaceAll('__COMPANION_STDERR__', xmlEscape(paths.stderrLog))
    .replaceAll('__PATH__', xmlEscape(config.pathEnv));

  const domain = `gui/${config.uid}`;
  try {
    await config.run('launchctl', ['bootout', domain, destination]);
  } catch {
    // Missing or unloaded services are already in the desired state.
  }

  await migrateLegacyFiles(config.home, paths);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, plist);
  await rename(temporary, destination);
  await config.run('launchctl', ['bootstrap', domain, destination]);

  return `Installed and started ${destination}`;
}

export async function uninstallMacOS(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  if (config.platform !== 'darwin') throw new Error('macOS uninstallation requires macOS.');

  const destination = join(config.home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
  try {
    await config.run('launchctl', ['bootout', `gui/${config.uid}`, destination]);
  } catch {
    // Idempotent when service is absent or unloaded.
  }
  await rm(destination, { force: true });
  return `Removed ${destination}`;
}

function piPaths(home: string, repoRoot: string) {
  const extensions = join(home, '.pi/agent/extensions');
  return {
    // Pi resolves bare imports from the installed path, not the symlink target, so the
    // extension ships as a self-contained bundle instead of the workspace source tree.
    source: join(repoRoot, 'packages/pi-extension/dist/index.js'),
    destination: join(extensions, 'mdello-companion.js'),
    // Pre-bundle installs symlinked the package directory here.
    legacy: join(extensions, 'mdello-companion'),
  };
}

async function removeManagedSymlink(path: string, verb: string, label: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === 'other') throw new Error(`${verb} non-symlink ${label} at ${path}.`);
  if (kind === 'symlink') await rm(path);
}

export async function installPi(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const { source, destination, legacy } = piPaths(config.home, config.repoRoot);

  if ((await pathKind(source)) === 'missing') {
    throw new Error(`Missing Pi extension bundle at ${source}. Run \`yarn build:pi-extension\`.`);
  }

  await removeManagedSymlink(destination, 'Cannot replace', 'Pi extension');
  await removeManagedSymlink(legacy, 'Cannot replace', 'Pi extension');

  await mkdir(dirname(destination), { recursive: true });
  await symlink(source, destination, 'file');
  return `Installed Pi extension ${destination} -> ${source}`;
}

export async function uninstallPi(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const { destination, legacy } = piPaths(config.home, config.repoRoot);

  await removeManagedSymlink(destination, 'Refusing to remove', 'Pi extension');
  await removeManagedSymlink(legacy, 'Refusing to remove', 'Pi extension');
  return `Removed Pi extension ${destination}`;
}

function companionEndpoint(options: InstallOptions): string {
  if (options.endpoint) return options.endpoint;
  const port = process.env.MDELLO_COMPANION_PORT ?? '31337';
  return `http://127.0.0.1:${port}`;
}

/**
 * Claude Code loads any directory under a skills directory that carries a plugin manifest, so the
 * integration is a plugin the installer owns end to end. Nothing in the user's settings is touched.
 */
function claudePluginDirectory(home: string): string {
  return join(home, '.claude/skills', PLUGIN_NAME);
}

async function readPluginManifest(directory: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, '.claude-plugin/plugin.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Refuses to touch a directory this installer did not create. */
async function assertOwnedPlugin(directory: string, verb: string): Promise<'missing' | 'ours'> {
  if ((await pathKind(directory)) === 'missing') return 'missing';
  if (isCompanionPlugin(await readPluginManifest(directory))) return 'ours';
  throw new Error(`${verb} unmanaged Claude plugin at ${directory}.`);
}

export async function installClaude(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const directory = claudePluginDirectory(config.home);
  const endpoint = companionEndpoint(options);

  await assertOwnedPlugin(directory, 'Cannot replace');
  await rm(directory, { recursive: true, force: true });
  for (const [name, contents] of Object.entries(claudePluginFiles(endpoint))) {
    const file = join(directory, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }

  return `Installed Claude plugin ${directory} -> ${endpoint}${HOOK_PATH}`;
}

export async function uninstallClaude(options: InstallOptions = {}): Promise<string> {
  const config = defaults(options);
  const directory = claudePluginDirectory(config.home);

  await assertOwnedPlugin(directory, 'Refusing to remove');
  await rm(directory, { recursive: true, force: true });
  return `Removed Claude plugin ${directory}`;
}

export async function installIntegrations(
  integration?: Integration,
  options: InstallOptions = {},
): Promise<string[]> {
  if (integration === 'macos') return [await installMacOS(options)];
  if (integration === 'pi') return [await installPi(options)];
  if (integration === 'claude') return [await installClaude(options)];

  const messages: string[] = [];
  if ((options.platform ?? process.platform) === 'darwin')
    messages.push(await installMacOS(options));
  messages.push(await installPi(options));
  messages.push(await installClaude(options));
  return messages;
}

export async function uninstallIntegrations(
  integration?: Integration,
  options: InstallOptions = {},
): Promise<string[]> {
  if (integration === 'macos') return [await uninstallMacOS(options)];
  if (integration === 'pi') return [await uninstallPi(options)];
  if (integration === 'claude') return [await uninstallClaude(options)];

  const messages: string[] = [];
  if ((options.platform ?? process.platform) === 'darwin') {
    messages.push(await uninstallMacOS(options));
  }
  messages.push(await uninstallPi(options));
  messages.push(await uninstallClaude(options));
  return messages;
}
